import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { ClosureClientsService } from './closure-clients.service';
import { ClosureBalanceAlert } from './entities/closure-balance-alert.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Alertas «cuenta cerrada con saldo» para cumplimiento (panel administrativo).
 * Resolver una alerta exige que la cuenta ya esté en $0 en el ledger: primero se
 * devuelve el dinero (reverso del movimiento que llegó) y luego se cierra la alerta.
 */
@Injectable()
export class ClosureAlertsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clients: ClosureClientsService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(status: 'open' | 'resolved' | 'all' = 'open') {
    const repo = this.dataSource.getRepository(ClosureBalanceAlert);
    const [items, abiertas] = await Promise.all([
      repo.find({ where: status === 'all' ? {} : { status }, order: { detectedAt: 'DESC' }, take: 200 }),
      repo.count({ where: { status: 'open' } }),
    ]);
    return { abiertas, items: items.map((a) => this.toPublic(a)) };
  }

  async resolve(id: string, note: string, staff: StaffPrincipal) {
    if (!UUID.test(id)) throw new NotFoundException('Alerta no encontrada.');
    return this.dataSource.transaction(async (manager) => {
      const alert = await manager.findOne(ClosureBalanceAlert, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!alert) throw new NotFoundException('Alerta no encontrada.');
      if (alert.status === 'resolved') throw new ConflictException('La alerta ya estaba resuelta.');

      const balance = await this.clients.balance(alert.accountId);
      if (balance !== 0) {
        throw new BadRequestException(
          `La cuenta todavía tiene ${balance} ${alert.currency}. Devuelve el dinero (reverso del movimiento) antes de cerrar la alerta.`,
        );
      }

      alert.status = 'resolved';
      alert.resolvedAt = new Date();
      alert.resolvedBy = staff.username;
      alert.resolutionNote = note;
      await manager.save(alert);
      await this.audit.record(
        staff,
        {
          action: 'closure_alert.resolved',
          targetType: 'account',
          targetId: alert.accountId,
          reason: note,
          details: { alertId: alert.id, balance: Number(alert.balance), currency: alert.currency },
        },
        manager,
      );
      return this.toPublic(alert);
    });
  }

  private toPublic(alert: ClosureBalanceAlert) {
    return {
      id: alert.id,
      idUser: alert.idUser,
      accountId: alert.accountId,
      accountNumber: alert.accountNumber,
      currency: alert.currency,
      balance: Number(alert.balance),
      closedAt: alert.closedAt,
      detectedAt: alert.detectedAt,
      status: alert.status,
      resolvedAt: alert.resolvedAt,
      resolvedBy: alert.resolvedBy,
      resolutionNote: alert.resolutionNote,
    };
  }
}
