import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ClosureClientsService } from './closure-clients.service';
import { ClosureBalanceAlert } from './entities/closure-balance-alert.entity';
import { ClosureTask, ClosureTaskKind } from './entities/closure-task.entity';

const RELAY_INTERVAL_MS = 5_000;
const BATCH_SIZE = 20;
// Espera después de cada falla: 10 s, 20 s, 40 s… hasta 1 h. No se rinde nunca:
// mientras auth no confirme, el cliente podría seguir entrando a una cuenta cerrada.
const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 60 * 60 * 1000;
// Desde este intento cada falla se registra como error (alguien debe revisarlo).
const ALERT_AFTER_ATTEMPTS = 5;

/**
 * Cuándo se vuelve a consultar el saldo después del cierre. Un movimiento que
 * leyó la cuenta como activa justo antes del cierre termina en el ledger en
 * pocos segundos (las escrituras entre servicios esperan máximo 15 s): a los
 * 30 s ya está reflejado en el saldo.
 */
export const BALANCE_CHECK_DELAY_MS = 30_000;

const LABELS: Record<ClosureTaskKind, string> = {
  auth_access: 'cerrar el acceso en auth',
  balance_check: 'revisar el saldo después del cierre',
};

/** Espera antes del siguiente intento, después de `attempts` fallas seguidas. */
export function retryDelayMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), MAX_DELAY_MS);
}

/**
 * Relevo de closure_tasks (lo que queda por hacer después de cancelar una cuenta).
 * Corre al arrancar, justo después de cada cierre y cada pocos segundos. El
 * estado (intentos, próximo intento, último error) vive en la base: si el
 * servicio se reinicia, retoma donde iba. Las dos tareas son idempotentes.
 */
@Injectable()
export class ClosureTasksRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ClosureTasksRelay');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly clients: ClosureClientsService,
  ) {}

  onModuleInit() {
    void this.run();
    this.timer = setInterval(() => void this.run(), RELAY_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ejecuta las tareas vencidas. Devuelve cuántas quedaron hechas en esta pasada. */
  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.dataSource.transaction(async (manager) => {
        // SKIP LOCKED: si hay varias réplicas, cada tarea la ejecuta solo una.
        const tasks = await manager
          .createQueryBuilder(ClosureTask, 'task')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .where('task.done_at IS NULL')
          .andWhere('task.next_attempt_at <= :now', { now })
          .orderBy('task.next_attempt_at', 'ASC')
          .limit(BATCH_SIZE)
          .getMany();

        let done = 0;
        for (const task of tasks) {
          const error = await this.execute(task, manager);
          task.attempts += 1;
          if (!error) {
            task.doneAt = new Date();
            task.lastError = null;
            done += 1;
            this.logger.log(`Listo: ${LABELS[task.kind]} para idUser=${task.idUser} (intento ${task.attempts}).`);
          } else {
            task.lastError = error.slice(0, 500);
            task.nextAttemptAt = new Date(now.getTime() + retryDelayMs(task.attempts));
            const message = `No se pudo ${LABELS[task.kind]} para idUser=${task.idUser} (intento ${task.attempts}); se reintenta el ${task.nextAttemptAt.toISOString()}: ${task.lastError}`;
            if (task.attempts >= ALERT_AFTER_ATTEMPTS) this.logger.error(message);
            else this.logger.warn(message);
          }
          await manager.save(task);
        }
        return done;
      });
    } catch (error) {
      this.logger.error(`Error procesando las tareas de cierre: ${(error as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** null si salió bien; si no, el motivo (se reintenta). */
  private execute(task: ClosureTask, manager: EntityManager): Promise<string | null> {
    if (task.kind === 'auth_access') return this.clients.closeAccessInAuth(task.idUser, task.closedAt);
    return this.checkBalances(task, manager);
  }

  /**
   * Saldo de cada cuenta que cerró este cierre. Si no es $0, abre la alerta
   * «cuenta cerrada con saldo» (una por cuenta: repetir la revisión no duplica).
   */
  private async checkBalances(task: ClosureTask, manager: EntityManager): Promise<string | null> {
    const accounts = await manager.find(Account, {
      where: { idUser: task.idUser, status: 'closed', closedAt: task.closedAt },
    });
    for (const account of accounts) {
      let balance: number;
      try {
        balance = await this.clients.balance(account.id);
      } catch (error) {
        return `Ledger no dio el saldo de la cuenta ${account.id}: ${(error as Error).message}`;
      }
      if (balance === 0) continue;
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(ClosureBalanceAlert)
        .values({
          idUser: task.idUser,
          accountId: account.id,
          accountNumber: account.accountNumber,
          currency: account.currency,
          balance: balance.toFixed(2),
          closedAt: task.closedAt,
          status: 'open',
        })
        .orIgnore()
        .execute();
      // ON CONFLICT DO NOTHING: raw trae la fila solo si la alerta es nueva.
      if ((inserted.raw as unknown[]).length) {
        this.logger.error(
          `Cuenta cerrada con saldo: cuenta ${account.id} (idUser=${task.idUser}) tiene ${balance} ${account.currency}. Cumplimiento debe devolverlo.`,
        );
      }
    }
    return null;
  }
}
