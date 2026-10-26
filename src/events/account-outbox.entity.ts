import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Patrón outbox: el evento (hoy solo account.closed) se guarda en la MISMA
 * transacción que el cambio de las cuentas, así nunca se pierde. OutboxService
 * lo publica en RabbitMQ y marca published_at; si RabbitMQ está caído, se
 * reintenta. occurred_at queda fijo para que los consumidores puedan deduplicar.
 */
@Entity('account_outbox')
@Index('idx_account_outbox_pending', ['publishedAt', 'createdAt'])
export class AccountOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'routing_key', type: 'varchar' })
  routingKey: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
