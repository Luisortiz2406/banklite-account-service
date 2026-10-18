import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  private requesterId(request: Request): string {
    return (request as any).user?.idUser as string;
  }

  @Post('create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateAccountDto, @Req() request: Request) {
    return this.accountsService.create(dto, this.requesterId(request));
  }

  @Get()
  list(@Req() request: Request) {
    return this.accountsService.listForUser(this.requesterId(request));
  }

  @Get(':account_id/limits')
  getLimits(@Param('account_id', ParseUUIDPipe) accountId: string, @Req() request: Request) {
    return this.accountsService.getLimits(accountId, this.requesterId(request));
  }

  @Put(':account_id/status')
  updateStatus(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Body() dto: UpdateStatusDto,
    @Req() request: Request,
  ) {
    return this.accountsService.updateStatus(accountId, dto, this.requesterId(request));
  }

  @Get(':account_id')
  findOne(@Param('account_id', ParseUUIDPipe) accountId: string, @Req() request: Request) {
    return this.accountsService.findOne(accountId, this.requesterId(request));
  }
}
