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

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([Account, IdentityVerification]),
  ],
  controllers: [AccountsController, InternalAccountsController],
  providers: [AccountsService, EventConsumerService, JwtAuthGuard, InternalKeyGuard],
})
export class AccountsModule {}
