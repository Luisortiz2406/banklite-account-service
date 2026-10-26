import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Equals, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ClosureService } from './closure.service';

class CloseAccountDto {
  // Ticket de cierre que entrega auth-service en POST /auth/cierre/confirmar.
  @IsString()
  @MaxLength(2000)
  ticket: string;

  @Equals('CANCELAR', { message: 'Escribe CANCELAR para confirmar.' })
  confirmacion: string;
}

const userOf = (request: Request): string => (request as any).user.idUser;
const tokenOf = (request: Request): string => String(request.headers.authorization || '').slice('Bearer '.length);

/** Cancelar la cuenta Banklite. Va antes que AccountsController: /accounts/:account_id capturaría /accounts/cierre. */
@Controller('accounts/cierre')
@UseGuards(JwtAuthGuard)
export class ClosureController {
  constructor(private readonly closure: ClosureService) {}

  /** Qué le falta al cliente para poder cancelar (saldo, ahorro, recargas, revisiones). */
  @Get('requisitos')
  requisitos(@Req() request: Request) {
    return this.closure.requisitos(userOf(request), tokenOf(request));
  }

  /** Cierra todas las cuentas del cliente con el ticket de cierre y la palabra CANCELAR. */
  @Post()
  @HttpCode(HttpStatus.OK)
  cerrar(@Body() dto: CloseAccountDto, @Req() request: Request) {
    return this.closure.close(userOf(request), tokenOf(request), dto.ticket);
  }
}
