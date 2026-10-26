import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Lo que queda por hacer después de cancelar una cuenta. Se guarda en la misma
 * transacción que el cierre y ClosureTasksRelayService lo ejecuta; como vive en
 * la base, los reintentos sobreviven a un reinicio del servicio.
 *
 * - auth_access: POST /internal/auth/cierre-acceso (sin inicio de sesión ni sesiones vivas).
 * - balance_check: volver a consultar el saldo de las cuentas cerradas un rato
 *   después del cierre; si no es $0, abre una alerta para cumplimiento
 *   (closure_balance_alerts).
 */
export type ClosureTaskKind = 'auth_access' | 'balance_check';

@Entity('closure_tasks')
@Index('idx_closure_tasks_due', ['doneAt', 'nextAttemptAt'])
export class ClosureTask {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @PrimaryColumn({ type: 'varchar', length: 20 })
  kind: ClosureTaskKind;

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  // Próximo intento: la espera crece con cada falla (ver ClosureTasksRelayService).
  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ name: 'done_at', type: 'timestamptz', nullable: true })
  doneAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
