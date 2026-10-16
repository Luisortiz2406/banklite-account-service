import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventConsumerService } from '../events/event-consumer.service';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Account } from './entities/account.entity';
import { IdentityVerification } from './entities/identity-verification.entity';
import { InternalAccountsController } from './internal-accounts.controller';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { AdminAccountsController } from '../admin/admin-accounts.controller';
import { AdminAccountsService } from '../admin/admin-accounts.service';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { BrebKey } from '../keys/entities/breb-key.entity';
import { InternalKeysController, KeysController } from '../keys/keys.controller';
import { KeysClientsService } from '../keys/keys-clients.service';
import { KeysService } from '../keys/keys.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([Account, IdentityVerification, AdminAudit, BrebKey]),
  ],
  // AdminAccountsController y KeysController primero: si no, /accounts/:account_id
  // capturaría /accounts/admin y /accounts/keys.
  controllers: [AdminAccountsController, KeysController, AccountsController, InternalKeysController, InternalAccountsController],
  providers: [
    AccountsService, EventConsumerService, JwtAuthGuard, InternalKeyGuard, AdminAccountsService, AdminAuditService, StaffAuthGuard,
    KeysService, KeysClientsService,
  ],
})
export class AccountsModule {}
