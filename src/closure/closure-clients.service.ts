import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { callService, HTTP_TIMEOUTS, requestService } from '../common/http/internal-http';

export interface SavingsClosureSummary {
  bolsillosConDinero: number;
  metasConDinero: number;
  saldoApartado: number;
  cdtsVigentes: number;
  operacionesEnProceso: number;
  sinPendientes: boolean;
}

export interface DepositsClosureSummary {
  recargasPendientes: number;
  recargasEnRevision: number;
  sinPendientes: boolean;
}

export interface FraudClosureSummary {
  alertasAbiertas: number;
  sinPendientes: boolean;
}

const UNAVAILABLE = 'No pudimos revisar todo lo necesario para cancelar tu cuenta. Inténtalo de nuevo en unos minutos.';

/**
 * Llamadas que necesita la cancelación de la cuenta, todas por la red interna con
 * la INTERNAL_API_KEY de account-service:
 * - ledger: saldo de cada cuenta (antes de cerrar y otra vez después del cierre).
 * - savings, deposit y fraud: su resumen-cierre, lo que impediría cancelar.
 * - auth (red interna): cerrar el acceso cuando las cuentas ya quedaron cerradas.
 * Si alguno no responde, no se puede cancelar (nunca se asume que está todo bien).
 */
@Injectable()
export class ClosureClientsService {
  constructor(private readonly config: ConfigService) {}

  /** Saldo de una cuenta (GET /ledger/internal/accounts/:id/balance; ledger solo se lo permite a account). */
  async balance(accountId: string): Promise<number> {
    const body = await this.internalGet<{ balance?: number }>(
      'Ledger Service',
      `${this.url('LEDGER_SERVICE_URL', 'http://localhost:3006')}/ledger/internal/accounts/${encodeURIComponent(accountId)}/balance`,
    );
    const balance = Number(body?.balance);
    if (!Number.isFinite(balance)) throw new ServiceUnavailableException(UNAVAILABLE);
    return balance;
  }

  savingsSummary(idUser: string) {
    return this.internalGet<SavingsClosureSummary>(
      'Savings Service',
      `${this.url('SAVINGS_SERVICE_URL', 'http://localhost:3013')}/internal/savings/users/${encodeURIComponent(idUser)}/resumen-cierre`,
    );
  }

  depositsSummary(idUser: string) {
    return this.internalGet<DepositsClosureSummary>(
      'Deposit Service',
      `${this.url('DEPOSIT_SERVICE_URL', 'http://localhost:3014')}/internal/deposits/users/${encodeURIComponent(idUser)}/resumen-cierre`,
    );
  }

  fraudSummary(idUser: string) {
    return this.internalGet<FraudClosureSummary>(
      'Fraud Service',
      `${this.url('FRAUD_SERVICE_URL', 'http://localhost:3009')}/internal/fraud/users/${encodeURIComponent(idUser)}/resumen-cierre`,
    );
  }

  /**
   * POST /internal/auth/cierre-acceso (idempotente en auth). No lanza: devuelve
   * null si salió bien o el motivo de la falla, para que el relevo lo guarde y
   * reintente más tarde.
   */
  async closeAccessInAuth(idUser: string, closedAt: Date): Promise<string | null> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) return 'INTERNAL_API_KEY no está configurada en Account Service.';
    const response = await requestService(
      `${this.url('AUTH_SERVICE_URL', 'http://localhost:3001')}/internal/auth/cierre-acceso`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ idUser, cerradaEn: closedAt.toISOString() }),
      },
    );
    if (!response) return 'Auth Service no respondió (red o tiempo agotado).';
    if (response.ok) return null;
    return `Auth Service respondió ${response.status}: ${response.message || 'sin mensaje'}`;
  }

  private async internalGet<T>(service: string, url: string): Promise<T> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new ServiceUnavailableException(UNAVAILABLE);
    return callService<T>(
      url,
      { headers: { 'x-internal-key': key }, timeoutMs: HTTP_TIMEOUTS.read, retry: true },
      {
        service,
        internal: true,
        unavailable: UNAVAILABLE,
        // 403 (no reconoce a account) o 404 (ruta que no existe): configuración, no un rechazo al cliente.
        on: {
          403: () => new ServiceUnavailableException(UNAVAILABLE),
          404: () => new ServiceUnavailableException(UNAVAILABLE),
        },
      },
    );
  }

  private url(key: string, fallback: string) {
    return this.config.get<string>(key, fallback).replace(/\/+$/, '');
  }
}
