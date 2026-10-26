import { ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { OutboxService } from '../events/outbox.service';
import { BrebKey } from '../keys/entities/breb-key.entity';
import { verifyClosureTicket } from './closure-ticket';
import { ClosureRequirementsService } from './closure-requirements.service';
import { AccountClosure } from './entities/account-closure.entity';
import { ClosureTask } from './entities/closure-task.entity';
import { BALANCE_CHECK_DELAY_MS, ClosureTasksRelayService } from './closure-tasks-relay.service';
import { ClosureTicketUse } from './entities/closure-ticket-use.entity';

export interface ClosureResult {
  cerrada: true;
  cerradaEn: string;
  cuentas: string[];
}

const INVALID_TICKET =
  'La confirmación no es válida o venció. Vuelve a confirmar con tu clave y el código que te enviamos.';
const USED_TICKET = 'Esta confirmación ya se usó. Vuelve a confirmar con tu clave y el código que te enviamos.';

/**
 * Cancelar la cuenta Banklite del cliente (todas sus cuentas):
 *   1. verifica el ticket de cierre que emitió auth (clave + código por WhatsApp);
 *   2. lo gasta (closure_ticket_uses, clave primaria = jti): un solo uso;
 *   3. vuelve a revisar los requisitos en ese momento (saldo, ahorro, recargas, seguridad);
 *   4. en una transacción: cierra las cuentas, borra las llaves Bre-B, guarda el
 *      cierre, el evento account.closed (outbox) y las tareas posteriores
 *      (cerrar el acceso en auth y volver a revisar el saldo: closure_tasks).
 * Repetir la misma solicitud (mismo ticket) devuelve el mismo cierre.
 */
@Injectable()
export class ClosureService {
  private readonly logger = new Logger('AccountClosure');

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly requirements: ClosureRequirementsService,
    private readonly outbox: OutboxService,
    private readonly tasks: ClosureTasksRelayService,
  ) {}

  requisitos(idUser: string) {
    return this.requirements.check(idUser);
  }

  async close(idUser: string, ticket: string): Promise<ClosureResult> {
    const secret = this.config.get<string>('CLOSURE_TICKET_SECRET');
    if (!secret) throw new ServiceUnavailableException('La cancelación de cuentas no está disponible en este momento.');
    const payload = verifyClosureTicket(ticket, secret);
    // El ticket es de este cliente: no sirve uno emitido para otra persona.
    if (!payload || payload.sub !== idUser) throw new ForbiddenException(INVALID_TICKET);

    const replay = await this.spendTicket(payload.jti, idUser);
    if (replay) return replay;

    try {
      const current = await this.requirements.check(idUser);
      if (!current.puedeCancelar) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Todavía hay algo pendiente para cancelar tu cuenta. Revísalo y vuelve a intentarlo.',
          pendientes: current.pendientes,
        });
      }
      const result = await this.closeInTransaction(idUser, payload.jti);
      // Sin esperar: si fallan, el relevo de cada uno lo reintenta.
      void this.outbox.flush();
      void this.tasks.run();
      return result;
    } catch (error) {
      // 409: algo pendiente (requisitos o un bloqueo del banco). Lo demás: una falla.
      await this.markTicket(payload.jti, error instanceof ConflictException ? 'requirements' : 'error');
      throw error;
    }
  }

  /** Marca el ticket como usado. Si ya lo estaba y cerró la cuenta, devuelve ese cierre. */
  private async spendTicket(jti: string, idUser: string): Promise<ClosureResult | null> {
    try {
      await this.dataSource.getRepository(ClosureTicketUse).insert({ jti, idUser, result: null });
      return null;
    } catch (error) {
      if ((error as any)?.code !== '23505') throw error;
      const closure = await this.dataSource.getRepository(AccountClosure).findOne({ where: { ticketJti: jti } });
      if (closure?.idUser === idUser) return this.toResult(closure);
      throw new ConflictException(USED_TICKET);
    }
  }

  private async closeInTransaction(idUser: string, jti: string): Promise<ClosureResult> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Bloquea las cuentas del cliente: nadie las cambia mientras se cierran.
        const accounts = await manager
          .createQueryBuilder(Account, 'a')
          .setLock('pessimistic_write')
          .where('a.id_user = :idUser', { idUser })
          .andWhere("a.status <> 'closed'")
          .andWhere("a.account_type <> 'merchant'")
          .orderBy('a.created_at', 'ASC')
          .getMany();

        const already = await manager.findOne(AccountClosure, { where: { idUser } });
        if (already) return this.toResult(already);

        // El banco pudo bloquear una cuenta después de la revisión de requisitos.
        if (accounts.some((a) => a.status === 'blocked' && a.blockedBy === 'bank')) {
          throw new ConflictException('El banco bloqueó una de tus cuentas. Comunícate con soporte para cancelarla.');
        }

        const closedAt = new Date();
        const accountNumbers = accounts.map((a) => a.accountNumber).filter((n): n is string => !!n);
        if (accounts.length) {
          await manager.update(
            Account,
            accounts.map((a) => a.id),
            { status: 'closed', closedAt },
          );
        }
        // Liberar las llaves Bre-B: otra persona podrá registrarlas.
        await manager.delete(BrebKey, { idUser });
        const closure = await manager.save(
          manager.create(AccountClosure, { idUser, closedAt, accountNumbers, ticketJti: jti }),
        );
        await this.outbox.enqueue(manager, 'account.closed', [
          { idUser, cerradaEn: closedAt.toISOString(), cuentas: accountNumbers },
        ]);
        await this.enqueueTasks(manager, idUser, closedAt);
        await manager.update(ClosureTicketUse, { jti }, { result: 'closed' });
        this.logger.log(`Cuenta cancelada: idUser=${idUser}, ${accounts.length} cuenta(s) cerrada(s).`);
        return this.toResult(closure);
      });
    } catch (error) {
      // Otra solicitud (con otro ticket) cerró la cuenta al mismo tiempo: se responde ese cierre.
      if ((error as any)?.code === '23505') {
        const closure = await this.dataSource.getRepository(AccountClosure).findOne({ where: { idUser } });
        if (closure) return this.toResult(closure);
      }
      throw error;
    }
  }

  /** Cerrar el acceso en auth (ya) y volver a revisar el saldo (en BALANCE_CHECK_DELAY_MS). */
  private enqueueTasks(manager: EntityManager, idUser: string, closedAt: Date) {
    const base = { idUser, closedAt, attempts: 0, doneAt: null, lastError: null };
    return manager.insert(ClosureTask, [
      { ...base, kind: 'auth_access', nextAttemptAt: closedAt },
      { ...base, kind: 'balance_check', nextAttemptAt: new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS) },
    ]);
  }

  private async markTicket(jti: string, result: 'requirements' | 'error') {
    await this.dataSource
      .getRepository(ClosureTicketUse)
      .update({ jti, result: IsNull() }, { result })
      .catch(() => undefined);
  }

  private toResult(closure: AccountClosure): ClosureResult {
    return { cerrada: true, cerradaEn: closure.closedAt.toISOString(), cuentas: closure.accountNumbers };
  }
}
