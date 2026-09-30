import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Tabla accounts. Antes los límites vivían en una tabla aparte
 * (account_limits, relación 1:1); se unieron aquí en una sola tabla
 * por petición del profesor.
 * id_user es una FK lógica (UUID) al Identity Service, sin join físico
 * entre bases de datos (4.10 Integridad de Datos sin Joins entre Microservicios).
 */
@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_accounts_user')
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Index({ unique: true })
  @Column({ name: 'account_number', type: 'varchar', length: 11, nullable: true })
  accountNumber: string | null;

  @Column({ name: 'account_type', type: 'varchar', default: 'savings' })
  accountType: 'savings' | 'checking';

  @Column({ length: 3 })
  currency: string; // ej. 'COP', 'USD'

  @Column({
    type: 'varchar',
    default: 'pending', // pending -> active tras identity.verified
  })
  status: 'pending' | 'active' | 'closed' | 'blocked';

  // Quién bloqueó la cuenta: el titular puede desbloquear solo sus propios bloqueos.
  @Column({ name: 'blocked_by', type: 'varchar', nullable: true })
  blockedBy: 'user' | 'bank' | null;

  @Column({ name: 'daily_limit', type: 'numeric', precision: 18, scale: 2, default: 0 })
  dailyLimit: number;

  @Column({ name: 'monthly_limit', type: 'numeric', precision: 18, scale: 2, default: 0 })
  monthlyLimit: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}