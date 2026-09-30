import { IsIn } from 'class-validator';

const ESTADOS_VALIDOS = ['active', 'closed', 'blocked'];

export class UpdateStatusDto {
  @IsIn(ESTADOS_VALIDOS, {
    message: `status debe ser una de: ${ESTADOS_VALIDOS.join(', ')}`,
  })
  status: 'active' | 'closed' | 'blocked';
}
