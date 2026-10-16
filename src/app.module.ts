import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from './accounts/accounts.module';
import { Account } from './accounts/entities/account.entity';
import { IdentityVerification } from './accounts/entities/identity-verification.entity';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { BrebKey } from './keys/entities/breb-key.entity';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
        { key: 'JWT_SECRET', type: 'secret' },
        { key: 'STAFF_JWT_SECRET', type: 'secret' },
        { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
        // Clave propia para llamar a auth-service (clave dinámica de las llaves Bre-B).
        { key: 'INTERNAL_API_KEY', type: 'secret' },
        { key: 'DATABASE_URL', type: 'url' },
        { key: 'RABBITMQ_URL', type: 'url', optional: true },
      ],
        ['JWT_SECRET', 'STAFF_JWT_SECRET', 'INTERNAL_API_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [Account, IdentityVerification, AdminAudit, BrebKey],
        synchronize: true, // demo académica; en producción usar migraciones
        logging: false,
      }),
    }),
    AccountsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
