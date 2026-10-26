import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { ClosureAlertsService } from './closure-alerts.service';

class ClosureAlertsQueryDto {
  @IsOptional() @IsIn(['open', 'resolved', 'all']) status?: 'open' | 'resolved' | 'all';
}

class ResolveClosureAlertDto {
  @IsString()
  @MinLength(5, { message: 'Escribe cómo se devolvió el dinero (mínimo 5 caracteres).' })
  @MaxLength(300)
  reason: string;
}

/**
 * Panel administrativo: alertas «cuenta cerrada con saldo». Solo cumplimiento y
 * administradores. Va antes que AccountsController (ver accounts.module.ts).
 */
@Controller('accounts/admin/closure-alerts')
@UseGuards(StaffAuthGuard)
@StaffRoles('compliance', 'admin')
export class ClosureAlertsController {
  constructor(private readonly alerts: ClosureAlertsService) {}

  @Get()
  list(@Query() q: ClosureAlertsQueryDto) {
    return this.alerts.list(q.status ?? 'open');
  }

  /** Marca la alerta como resuelta. La cuenta ya debe estar en $0 en el ledger. */
  @Post(':id/resolve')
  @HttpCode(200)
  resolve(@Param('id') id: string, @Body() dto: ResolveClosureAlertDto, @Req() req: any) {
    return this.alerts.resolve(id, dto.reason.trim(), req.staff);
  }
}
