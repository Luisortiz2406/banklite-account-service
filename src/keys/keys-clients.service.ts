import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface KycProfile {
  nombres?: string;
  apellidos?: string;
  numeroDocumento?: string;
  email?: string | null;
  telefono?: string | null;
}

/**
 * Llamadas que necesita el directorio de llaves:
 * - KYC (con el token del propio cliente): sus datos verificados, para que solo
 *   pueda registrar SU celular, SU correo y SU cédula.
 * - Auth (red interna, INTERNAL_API_KEY de account-service): clave dinámica.
 */
@Injectable()
export class KeysClientsService {
  constructor(private readonly config: ConfigService) {}

  async kycProfile(idUser: string, accessToken: string): Promise<KycProfile> {
    const baseUrl = this.config.get<string>('KYC_SERVICE_URL', 'http://localhost:3003');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/kyc/${encodeURIComponent(idUser)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudieron consultar tus datos. Inténtalo de nuevo.');
    }
    if (response.status === 404) throw new BadRequestException('Primero completa la verificación de identidad.');
    if (!response.ok) throw new ServiceUnavailableException('No se pudieron consultar tus datos. Inténtalo de nuevo.');
    return response.json() as Promise<KycProfile>;
  }

  async verifyDynamicKey(idUser: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Account Service.');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/dynamic-key/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser, code }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 403 && /clave dinámica/i.test(payload?.message || ''))
      throw new ForbiddenException(payload.message);
    if (!response.ok)
      throw new ServiceUnavailableException('No se pudo validar la clave dinámica. Inténtalo de nuevo.');
    if (payload?.valid !== true)
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
  }
}
