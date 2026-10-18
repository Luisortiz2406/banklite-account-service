import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS } from '../common/http/internal-http';

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
 * Errores: regla común de common/http/internal-http.ts.
 */
@Injectable()
export class KeysClientsService {
  constructor(private readonly config: ConfigService) {}

  async kycProfile(idUser: string, accessToken: string): Promise<KycProfile> {
    const baseUrl = this.config.get<string>('KYC_SERVICE_URL', 'http://localhost:3003');
    return callService<KycProfile>(
      `${baseUrl}/kyc/${encodeURIComponent(idUser)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service: 'KYC Service',
        internal: false,
        unavailable: 'No se pudieron consultar tus datos. Inténtalo de nuevo.',
        on: { 404: () => new BadRequestException('Primero completa la verificación de identidad.') },
      },
    );
  }

  async verifyDynamicKey(idUser: string, code: string): Promise<void> {
    const baseUrl = this.config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException('INTERNAL_API_KEY no está configurada en Account Service.');
    const payload = await callService<{ valid?: boolean; message?: string }>(
      `${baseUrl}/internal/dynamic-key/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser, code }),
      },
      {
        service: 'Auth Service',
        internal: true,
        unavailable: 'No se pudo validar la clave dinámica. Inténtalo de nuevo.',
      },
    );
    if (payload?.valid !== true) {
      throw new BadRequestException(payload?.message || 'Clave dinámica incorrecta o vencida.');
    }
  }
}
