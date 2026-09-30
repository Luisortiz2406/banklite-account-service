import { IsIn, IsNumber, IsOptional, IsUUID, Min } from 'class-validator';

const MONEDAS_SOPORTADAS = ['COP', 'USD'];

export class CreateAccountDto {
  @IsUUID()
  idUser: string;

  @IsIn(MONEDAS_SOPORTADAS, {
    message: `currency debe ser una de: ${MONEDAS_SOPORTADAS.join(', ')}`,
  })
  currency: string;

  @IsOptional()
  @IsIn(['savings', 'checking'], { message: 'accountType debe ser savings o checking' })
  accountType?: 'savings' | 'checking';

  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyLimit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyLimit?: number;
}
