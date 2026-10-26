import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Tarea pendiente "cerrar el acceso en auth-service" (POST
 * /internal/auth/cierre-acceso). Se guarda en la misma transacción que el
 * cierre de las cuentas y AuthAccessRelayService la ejecuta. Como vive en la
 * base, los reintentos sobreviven a un reinicio del servicio.
 */
@Entity('auth_access_tasks')
@Index('idx_auth_access_tasks_due', ['doneAt', 'nextAttemptAt'])
export class AuthAccessTask {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  // Próximo intento: la espera crece con cada falla (ver AuthAccessRelayService).
  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ name: 'done_at', type: 'timestamptz', nullable: true })
  doneAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
