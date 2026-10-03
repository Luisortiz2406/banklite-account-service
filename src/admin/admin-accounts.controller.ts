import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminAccountsQueryDto, AdminLimitsDto, AdminStatusDto, AuditQueryDto } from './admin.dto';

/**
 * Panel administrativo de Account Service. Va registrado ANTES que
 * AccountsController para que /accounts/:account_id no capture /accounts/admin/...
 */
@Controller('accounts/admin')
@UseGuards(StaffAuthGuard)
export class AdminAccountsController {
  constructor(
    private readonly admin: AdminAccountsService,
    private readonly audit: AdminAuditService,
    private readonly consumer: EventConsumerService,
  ) {}

  @Get('accounts')
  list(@Query() q: AdminAccountsQueryDto) {
    return this.admin.list(q.q, q.status, q.page ?? 1, q.limit ?? 25);
  }

  @Get('accounts/:id')
  detail(@Param('id') id: string) {
    return this.admin.detail(id);
  }

  @Patch('accounts/:id/status')
  @StaffRoles('admin')
  setStatus(@Param('id') id: string, @Body() dto: AdminStatusDto, @Req() req: any) {
    return this.admin.setStatus(id, dto.status, dto.reason, req.staff);
  }

  @Patch('accounts/:id/limits')
  @StaffRoles('admin')
  setLimits(@Param('id') id: string, @Body() dto: AdminLimitsDto, @Req() req: any) {
    return this.admin.setLimits(id, dto.dailyLimit, dto.monthlyLimit, dto.reason, req.staff);
  }

  @Get('audit')
  auditLog(@Query() q: AuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }

  @Get('dlq')
  dlq() {
    return this.consumer.deadLetterStats();
  }

  @Get('dlq/messages')
  async dlqMessages() {
    try {
      return await this.consumer.peekDeadLetters(20);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  @Post('dlq/requeue')
  @HttpCode(200)
  @StaffRoles('admin')
  async requeue(@Req() req: any) {
    try {
      const result = await this.consumer.requeueDeadLetters(100);
      await this.audit.record(req.staff, { action: 'dlq.requeue', targetType: 'queue', targetId: 'account-service', details: result });
      return result;
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }
}
