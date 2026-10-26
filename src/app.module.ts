import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from './accounts/accounts.module';
import { Account } from './accounts/entities/account.entity';
import { IdentityVerification } from './accounts/entities/identity-verification.entity';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { BrebKey } from './keys/entities/breb-key.entity';
import { AccountClosure } from './closure/entities/account-closure.entity';
import { AuthAccessTask } from './closure/entities/auth-access-task.entity';
import { ClosureTicketUse } from './closure/entities/closure-ticket-use.entity';
import { AccountOutbox } from './events/account-outbox.entity';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

const validateCommon = validateEnv(
  [
    { key: 'JWT_SECRET', type: 'secret' },
    { key: 'STAFF_JWT_SECRET', type: 'secret' },
    { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
    // Clave propia para llamar a otros servicios (auth, savings, deposit, fraud).
    { key: 'INTERNAL_API_KEY', type: 'secret' },
    { key: 'DATABASE_URL', type: 'url' },
    { key: 'RABBITMQ_URL', type: 'url', optional: true },
  ],
  ['JWT_SECRET', 'STAFF_JWT_SECRET', 'INTERNAL_API_KEY', 'CLOSURE_TICKET_SECRET'],
);

// Igual que en auth-service: opcional (sin él no se puede cancelar la cuenta),
// pero si está debe ser fuerte y sin espacios ni comillas pegados.
function validateClosureSecret(config: Record<string, unknown>) {
  const secret = config.CLOSURE_TICKET_SECRET;
  if (typeof secret === 'string' && secret !== '') {
    if (secret !== secret.trim() || /^["']|["']$/.test(secret)) {
      throw new Error('CLOSURE_TICKET_SECRET tiene espacios o comillas al inicio o al final: escríbela sin ellos.');
    }
    if (secret.length < 32) throw new Error('CLOSURE_TICKET_SECRET debe tener al menos 32 caracteres aleatorios.');
  }
  return config;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (config) => validateClosureSecret(validateCommon(config)),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [
          Account,
          IdentityVerification,
          AdminAudit,
          BrebKey,
          AccountClosure,
          ClosureTicketUse,
          AuthAccessTask,
          AccountOutbox,
        ],
        synchronize: true, // demo académica; en producción usar migraciones
        logging: false,
      }),
    }),
    AccountsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
