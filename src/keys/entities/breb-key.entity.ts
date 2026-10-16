import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BrebKeyType } from '../breb';

/**
 * Directorio de llaves Bre-B de los clientes Banklite: cada llave apunta a una
 * cuenta. Una llave pertenece a una sola persona y cada persona tiene máximo
 * una llave por tipo.
 */
@Entity('breb_keys')
@Index('uq_breb_keys_user_type', ['idUser', 'type'], { unique: true })
export class BrebKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('uq_breb_keys_key', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  key: string;

  @Column({ type: 'varchar', length: 12 })
  type: BrebKeyType;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  // Nombre del titular ya enmascarado ("Lau••• Góm•••"): es lo único que ve quien envía.
  @Column({ name: 'holder_name', type: 'varchar', length: 80 })
  holderName: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
