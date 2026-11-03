import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BREB_KEY_TYPES, BrebKeyType } from './breb';
import { KeysService } from './keys.service';

class RegisterKeyDto {
  @IsIn(BREB_KEY_TYPES)
  type: BrebKeyType;

  @IsString()
  @MaxLength(120)
  key: string;

  // Clave dinámica de 6 dígitos: la valida Auth Service.
  @Matches(/^\d{6}$/, { message: 'Ingresa tu clave dinámica de 6 dígitos.' })
  dynamicCode: string;
}

class RemoveKeyDto {
  @Matches(/^\d{6}$/, { message: 'Ingresa tu clave dinámica de 6 dígitos.' })
  dynamicCode: string;
}

class LookupKeyDto {
  @IsString()
  @MaxLength(120)
  key: string;
}

const userOf = (request: Request): string => (request as any).user.idUser;
const tokenOf = (request: Request): string => String(request.headers.authorization || '').slice('Bearer '.length);

/** Llaves Banklite del cliente. Va antes que AccountsController: /accounts/:account_id capturaría /accounts/keys. */
@Controller('accounts/keys')
@UseGuards(JwtAuthGuard)
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  list(@Req() request: Request) {
    return this.keys.list(userOf(request));
  }

  @Get('lookup')
  lookup(@Query() query: LookupKeyDto, @Req() request: Request) {
    return this.keys.lookup(userOf(request), query.key);
  }

  @Post()
  register(@Body() dto: RegisterKeyDto, @Req() request: Request) {
    return this.keys.register(userOf(request), tokenOf(request), dto.type, dto.key, dto.dynamicCode);
  }

  @Post(':type/remove')
  @HttpCode(HttpStatus.OK)
  remove(@Param('type') type: string, @Body() dto: RemoveKeyDto, @Req() request: Request) {
    if (!BREB_KEY_TYPES.includes(type as BrebKeyType)) throw new NotFoundException('Tipo de llave no válido.');
    return this.keys.remove(userOf(request), type as BrebKeyType, dto.dynamicCode);
  }
}

/** Resolución de llaves entre servicios (transfer-service). El gateway no publica /internal. */
@Controller('internal/accounts/keys')
@UseGuards(InternalKeyGuard)
export class InternalKeysController {
  constructor(private readonly keys: KeysService) {}

  @Get('resolve')
  resolve(@Query() query: LookupKeyDto) {
    return this.keys.resolveInternal(query.key);
  }
}
