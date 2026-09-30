import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Proyección local (read model) del evento identity.verified publicado
 * por el Identity Service. Account Service NO consulta la base de datos
 * de Identity directamente (aislamiento estricto, 4.10 del documento);
 * en su lugar, escucha el evento asíncrono y mantiene esta tabla.
 */
@Entity('identity_verifications')
export class IdentityVerification {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ default: true })
  verified: boolean;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;
}
