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
import { ClosureAlertsController } from '../closure/closure-alerts.controller';
import { ClosureAlertsService } from '../closure/closure-alerts.service';
import { ClosureTasksRelayService } from '../closure/closure-tasks-relay.service';
import { ClosureClientsService } from '../closure/closure-clients.service';
import { ClosureController } from '../closure/closure.controller';
import { ClosureRequirementsService } from '../closure/closure-requirements.service';
import { ClosureService } from '../closure/closure.service';
import { AccountClosure } from '../closure/entities/account-closure.entity';
import { ClosureBalanceAlert } from '../closure/entities/closure-balance-alert.entity';
import { ClosureTask } from '../closure/entities/closure-task.entity';
import { ClosureTicketUse } from '../closure/entities/closure-ticket-use.entity';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      Account,
      IdentityVerification,
      AdminAudit,
      BrebKey,
      AccountClosure,
      ClosureTicketUse,
      ClosureTask,
      ClosureBalanceAlert,
    ]),
    EventsModule,
  ],
  // Los controladores de /accounts/admin, /accounts/keys y /accounts/cierre primero:
  // si no, /accounts/:account_id los capturaría.
  controllers: [
    ClosureAlertsController,
    AdminAccountsController,
    KeysController,
    ClosureController,
    AccountsController,
    InternalKeysController,
    InternalAccountsController,
  ],
  providers: [
    AccountsService,
    EventConsumerService,
    JwtAuthGuard,
    InternalKeyGuard,
    AdminAccountsService,
    AdminAuditService,
    StaffAuthGuard,
    KeysService,
    KeysClientsService,
    ClosureClientsService,
    ClosureRequirementsService,
    ClosureService,
    ClosureTasksRelayService,
    ClosureAlertsService,
  ],
})
export class AccountsModule {}
