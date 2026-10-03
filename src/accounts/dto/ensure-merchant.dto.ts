import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** POST /internal/accounts/merchants — cuenta de un comercio (idempotente por code). */
export class EnsureMerchantDto {
  @Matches(/^[a-z0-9-]{2,40}$/, { message: 'code: minúsculas, números y guiones (2 a 40).' })
  code: string;

  @IsString()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsIn(['COP', 'USD'])
  currency?: string;
}
