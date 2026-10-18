import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cuentas vistas desde el panel: búsqueda, estado (bloqueo del banco / cierre) y límites. */
@Injectable()
export class AdminAccountsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly audit: AdminAuditService,
  ) {}

  async list(q?: string, status?: string, page = 1, limit = 25) {
    const qb = this.accounts.createQueryBuilder('a').orderBy('a.createdAt', 'DESC');
    const term = q?.trim();
    if (term) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('a.accountNumber LIKE :num', { num: `${term.replace(/\D/g, '') || '-'}%` });
          if (UUID.test(term)) w.orWhere('(a.idUser = :id OR a.id = :id)', { id: term });
        }),
      );
    }
    if (status) qb.andWhere('a.status = :status', { status });
    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items: items.map((a) => this.publicAccount(a)), total, page, limit };
  }

  async detail(id: string) {
    return this.publicAccount(await this.find(id));
  }

  /**
   * Cambios de estado del banco: bloquear (blockedBy = 'bank', el titular no lo
   * puede levantar), desbloquear (cualquier bloqueo) y cerrar (definitivo).
   * Una cuenta 'pending' solo se activa con identity.verified.
   */
  async setStatus(id: string, status: 'active' | 'blocked' | 'closed', reason: string, actor: StaffPrincipal) {
    const account = await this.find(id);
    const from = account.status;
    if (from === 'closed') throw new BadRequestException('La cuenta está cerrada; no admite cambios.');
    if (from === status) throw new BadRequestException(`La cuenta ya está en estado '${status}'.`);
    if (from === 'pending' && status !== 'closed') {
      throw new BadRequestException(
        'Una cuenta pendiente se activa sola al verificarse la identidad; solo se puede cerrar.',
      );
    }
    account.status = status;
    account.blockedBy = status === 'blocked' ? 'bank' : null;
    await this.accounts.manager.transaction(async (manager) => {
      await manager.save(account);
      await this.audit.record(
        actor,
        { action: `account.${status}`, targetType: 'account', targetId: id, reason, details: { from, to: status } },
        manager,
      );
    });
    return this.publicAccount(account);
  }

  async setLimits(id: string, dailyLimit: number, monthlyLimit: number, reason: string, actor: StaffPrincipal) {
    if (monthlyLimit < dailyLimit) throw new BadRequestException('El límite mensual no puede ser menor que el diario.');
    const account = await this.find(id);
    if (account.status === 'closed') throw new BadRequestException('La cuenta está cerrada; no admite cambios.');
    const before = { dailyLimit: Number(account.dailyLimit), monthlyLimit: Number(account.monthlyLimit) };
    Object.assign(account, { dailyLimit, monthlyLimit });
    await this.accounts.manager.transaction(async (manager) => {
      await manager.save(account);
      await this.audit.record(
        actor,
        {
          action: 'account.limits',
          targetType: 'account',
          targetId: id,
          reason,
          details: { before, after: { dailyLimit, monthlyLimit } },
        },
        manager,
      );
    });
    return this.publicAccount(account);
  }

  private async find(id: string) {
    const account = UUID.test(id) ? await this.accounts.findOne({ where: { id } }) : null;
    if (!account) throw new NotFoundException('Cuenta no encontrada.');
    return account;
  }

  private publicAccount(a: Account) {
    return {
      id: a.id,
      idUser: a.idUser,
      accountNumber: a.accountNumber,
      accountType: a.accountType,
      currency: a.currency,
      status: a.status,
      blockedBy: a.blockedBy,
      dailyLimit: Number(a.dailyLimit),
      monthlyLimit: Number(a.monthlyLimit),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}
