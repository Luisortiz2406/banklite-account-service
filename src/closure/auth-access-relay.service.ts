import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClosureClientsService } from './closure-clients.service';
import { AuthAccessTask } from './entities/auth-access-task.entity';

const RELAY_INTERVAL_MS = 5_000;
const BATCH_SIZE = 20;
// Espera después de cada falla: 10 s, 20 s, 40 s… hasta 1 h. No se rinde nunca:
// mientras auth no confirme, el cliente podría seguir entrando a una cuenta cerrada.
const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 60 * 60 * 1000;
// Desde este intento cada falla se registra como error (alguien debe revisarlo).
const ALERT_AFTER_ATTEMPTS = 5;

/** Espera antes del siguiente intento, después de `attempts` fallas seguidas. */
export function retryDelayMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), MAX_DELAY_MS);
}

/**
 * Relevo de auth_access_tasks: pide a auth-service que cierre el acceso de los
 * clientes que cancelaron su cuenta (POST /internal/auth/cierre-acceso, que es
 * idempotente). Corre al arrancar, justo después de cada cierre y cada pocos
 * segundos. El estado (intentos, próximo intento, último error) vive en la base:
 * si el servicio se reinicia, retoma donde iba.
 */
@Injectable()
export class AuthAccessRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AuthAccessRelay');
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

  /** Intenta las tareas vencidas. Devuelve cuántas quedaron hechas en esta pasada. */
  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.dataSource.transaction(async (manager) => {
        // SKIP LOCKED: si hay varias réplicas, cada tarea la intenta solo una.
        const tasks = await manager
          .createQueryBuilder(AuthAccessTask, 'task')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .where('task.done_at IS NULL')
          .andWhere('task.next_attempt_at <= :now', { now })
          .orderBy('task.next_attempt_at', 'ASC')
          .limit(BATCH_SIZE)
          .getMany();

        let done = 0;
        for (const task of tasks) {
          const error = await this.clients.closeAccessInAuth(task.idUser, task.closedAt);
          task.attempts += 1;
          if (!error) {
            task.doneAt = new Date();
            task.lastError = null;
            done += 1;
            this.logger.log(`Acceso cerrado en auth para idUser=${task.idUser} (intento ${task.attempts}).`);
          } else {
            task.lastError = error.slice(0, 500);
            task.nextAttemptAt = new Date(now.getTime() + retryDelayMs(task.attempts));
            const message = `No se pudo cerrar el acceso en auth para idUser=${task.idUser} (intento ${task.attempts}); se reintenta el ${task.nextAttemptAt.toISOString()}: ${task.lastError}`;
            if (task.attempts >= ALERT_AFTER_ATTEMPTS) this.logger.error(message);
            else this.logger.warn(message);
          }
          await manager.save(task);
        }
        return done;
      });
    } catch (error) {
      this.logger.error(`Error procesando las tareas de cierre de acceso: ${(error as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
