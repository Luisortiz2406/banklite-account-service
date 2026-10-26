import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tickets de cierre ya usados. El jti es la clave primaria: dos solicitudes con
 * el mismo ticket, aunque lleguen al mismo tiempo, no pueden pasar las dos.
 * El ticket se gasta al primer intento, aunque el cierre no se complete (por
 * ejemplo, si al cerrar ya no se cumplen los requisitos).
 */
@Entity('closure_ticket_uses')
export class ClosureTicketUse {
  @PrimaryColumn({ type: 'uuid' })
  jti: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // closed: cerró la cuenta · requirements: ya no cumplía los requisitos · error: otra falla.
  @Column({ type: 'varchar', length: 20, nullable: true })
  result: 'closed' | 'requirements' | 'error' | null;

  @CreateDateColumn({ name: 'used_at', type: 'timestamptz' })
  usedAt: Date;
}
