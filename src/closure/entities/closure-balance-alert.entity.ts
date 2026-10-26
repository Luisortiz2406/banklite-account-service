import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Alerta «cuenta cerrada con saldo»: después de cancelar, el ledger mostró que
 * a la cuenta le llegó (o le quedó) dinero. Cumplimiento la ve en el panel,
 * devuelve el dinero a mano (reverso del movimiento) y la marca como resuelta.
 * Una alerta por cuenta.
 */
@Entity('closure_balance_alerts')
@Index('idx_closure_balance_alerts_status', ['status', 'detectedAt'])
export class ClosureBalanceAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Index('uq_closure_balance_alerts_account', { unique: true })
  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'account_number', type: 'varchar', length: 11, nullable: true })
  accountNumber: string | null;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  // Saldo que tenía la cuenta cuando se detectó.
  @Column({ type: 'numeric', precision: 18, scale: 2 })
  balance: string;

  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  @CreateDateColumn({ name: 'detected_at', type: 'timestamptz' })
  detectedAt: Date;

  @Column({ type: 'varchar', length: 10, default: 'open' })
  status: 'open' | 'resolved';

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  // Usuario del empleado que la resolvió.
  @Column({ name: 'resolved_by', type: 'varchar', length: 80, nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolution_note', type: 'varchar', length: 300, nullable: true })
  resolutionNote: string | null;
}
