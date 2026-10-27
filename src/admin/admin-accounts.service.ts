import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal, StaffRole } from '../common/staff/staff-auth.guard';
import { AccountClosure } from '../closure/entities/account-closure.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Quién ve los datos de cierre (fecha y origen) y puede filtrar las cuentas cerradas.
const CLOSURE_VIEWERS: readonly StaffRole[] = ['compliance', 'admin'];
export const canSeeClosures = (staff: StaffPrincipal) => CLOSURE_VIEWERS.includes(staff.role);

// cliente: la canceló el titular desde la app (account_closures); banco: la cerró un administrador.
export type ClosedBy = 'cliente' | 'banco';

/** Cuentas vistas desde el panel: búsqueda, estado (bloqueo del banco / cierre) y límites. */
@Injectable()
export class AdminAccountsService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(AccountClosure) private readonly closures: Repository<AccountClosure>,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Con cumplimiento o admin, las cuentas cerradas traen `closedAt` y `cerradaPor`, y
   * la consulta queda en la bitácora. Soporte no puede filtrar por cerradas (403).
   */
  async list(viewer: StaffPrincipal, q?: string, status?: string, page = 1, limit = 25) {
    if (status === 'closed' && !canSeeClosures(viewer))
      throw new ForbiddenException('Solo cumplimiento y administradores pueden ver las cuentas cerradas.');
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
    if (!canSeeClosures(viewer)) return { items: items.map((a) => this.publicAccount(a)), total, page, limit };

    const closedBy = await this.closedByMap(items);
    const closed = items.filter((a) => a.status === 'closed');
    if (closed.length)
      await this.audit.record(viewer, {
        action: 'account_closure.list_viewed',
        targetType: 'account',
        targetId: 'listado',
        details: { status: status ?? null, q: term || null, page, cuentas: closed.map((a) => a.id) },
      });
    return { items: items.map((a) => this.withClosure(a, closedBy)), total, page, limit };
  }

  async detail(id: string, viewer: StaffPrincipal) {
    const account = await this.find(id);
    if (account.status !== 'closed' || !canSeeClosures(viewer)) return this.publicAccount(account);
    const closedBy = await this.closedByMap([account]);
    await this.audit.record(viewer, { action: 'account_closure.viewed', targetType: 'account', targetId: id });
    return this.withClosure(account, closedBy);
  }

  /** Cierre del cliente desde la app (ficha del cliente): fecha y cuentas. Solo cumplimiento y admin. */
  async closure(idUser: string, viewer: StaffPrincipal) {
    const closure = await this.closures.findOne({ where: { idUser } });
    if (!closure) throw new NotFoundException('Este cliente no canceló su cuenta desde la app.');
    await this.audit.record(viewer, {
      action: 'account_closure.viewed',
      targetType: 'account_closure',
      targetId: idUser,
    });
    return {
      idUser: closure.idUser,
      cerradaEn: closure.closedAt,
      cuentas: closure.accountNumbers,
      cerradaPor: 'cliente' as ClosedBy,
    };
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
    if (status === 'closed') account.closedAt = new Date();
    await this.accounts.manager.transaction(async (manager) => {
      // El cliente pudo cancelar su cuenta mientras tanto: nunca se pisa ese cierre.
      const locked = await manager.findOne(Account, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (locked?.status !== from) {
        throw new ConflictException('La cuenta cambió de estado mientras tanto. Recarga e inténtalo de nuevo.');
      }
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

  /** Para cada cuenta cerrada: quién la cerró (el titular si su número está en su cierre desde la app). */
  private async closedByMap(accounts: Account[]) {
    const closed = accounts.filter((a) => a.status === 'closed');
    const result = new Map<string, ClosedBy>();
    if (!closed.length) return result;
    const rows = await this.closures.find({ where: { idUser: In([...new Set(closed.map((a) => a.idUser))]) } });
    const byUser = new Map(rows.map((r) => [r.idUser, new Set(r.accountNumbers)]));
    for (const a of closed)
      result.set(a.id, a.accountNumber && byUser.get(a.idUser)?.has(a.accountNumber) ? 'cliente' : 'banco');
    return result;
  }

  private withClosure(a: Account, closedBy: Map<string, ClosedBy>) {
    return { ...this.publicAccount(a), closedAt: a.closedAt, cerradaPor: closedBy.get(a.id) ?? null };
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
