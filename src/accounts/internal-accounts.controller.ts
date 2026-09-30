import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { AccountsService } from './accounts.service';

@Controller('internal/accounts')
@UseGuards(InternalKeyGuard)
export class InternalAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get(':account_id/ledger-info')
  ledgerInfo(@Param('account_id', ParseUUIDPipe) accountId: string) {
    return this.accounts.findLedgerInfo(accountId);
  }

  @Get('number/:account_number/ledger-info')
  ledgerInfoByNumber(@Param('account_number') accountNumber: string) {
    return this.accounts.findLedgerInfoByNumber(accountNumber);
  }
}