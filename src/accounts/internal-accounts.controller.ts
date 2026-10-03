import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { AccountsService } from './accounts.service';
import { EnsureMerchantDto } from './dto/ensure-merchant.dto';

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

  /** Cuenta de comercio para los cobros de suscripciones (idempotente por code). */
  @Post('merchants')
  @HttpCode(HttpStatus.OK)
  ensureMerchant(@Body() dto: EnsureMerchantDto) {
    return this.accounts.ensureMerchant(dto);
  }
}
