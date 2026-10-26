import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Cierre de la relación de un cliente con Banklite (todas sus cuentas). Una
 * fila por cliente: la clave primaria impide cerrar dos veces. Las cuentas no
 * se borran; quedan en accounts con status 'closed'.
 */
@Entity('account_closures')
export class AccountClosure {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  // Números de las cuentas que se cerraron (los mismos de account.closed).
  @Column({ name: 'account_numbers', type: 'jsonb' })
  accountNumbers: string[];

  // Ticket con el que se cerró: si el cliente reenvía la misma solicitud, se le
  // responde este mismo cierre en vez de un error.
  @Index('uq_account_closures_ticket', { unique: true })
  @Column({ name: 'ticket_jti', type: 'uuid' })
  ticketJti: string;
}
