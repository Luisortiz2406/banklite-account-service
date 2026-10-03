import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AdminAccountsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['pending', 'active', 'blocked', 'closed']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class AdminStatusDto {
  @IsIn(['active', 'blocked', 'closed']) status: 'active' | 'blocked' | 'closed';
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(300) reason: string;
}

export class AdminLimitsDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) dailyLimit: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000_000) monthlyLimit: number;
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(300) reason: string;
}

export class AuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
