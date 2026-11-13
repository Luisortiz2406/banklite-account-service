import { Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Resultados de una solicitud de cancelación de cuenta: lista CERRADA (los mismos tres que se guardan en
 * closure_ticket_uses.result).
 *   - completed: se cerraron las cuentas del cliente (una sola vez por cliente).
 *   - requirements: no se cerró porque queda algo pendiente (saldo, ahorro, recargas, revisiones de
 *     seguridad o un bloqueo del banco).
 *   - error: no se cerró por una falla (otro servicio sin respuesta, error inesperado).
 */
export const CLOSURE_RESULTS = ['completed', 'requirements', 'error'] as const;
export type ClosureResult = (typeof CLOSURE_RESULTS)[number];

/**
 * account_closures_total{result}: cancelaciones de cuenta por resultado. La única etiqueta es `result` y solo
 * toma los valores de la lista cerrada: nunca ids de usuario, números de cuenta, correos, motivos ni los
 * pendientes del cliente (esos van en la respuesta al cliente, no en las métricas).
 *
 * CONTAR NUNCA ROMPE UN CIERRE DE CUENTA: ni el constructor ni record() lanzan jamás; si prom-client falla
 * se deja un aviso en el log y el cierre sigue como si nada.
 */
@Injectable()
export class ClosureMetrics {
  private readonly logger = new Logger('ClosureMetrics');
  private closures: Counter<'result'> | null = null;

  constructor(metrics: MetricsService) {
    try {
      const counter = new Counter({
        name: 'account_closures_total',
        help: 'Cancelaciones de cuenta por resultado: completed, requirements o error.',
        labelNames: ['result'],
        registers: [metrics.registry],
      });
      // Todas las series existen desde el arranque (en 0): así increase() y rate() ven el primer evento.
      for (const result of CLOSURE_RESULTS) counter.inc({ result }, 0);
      this.closures = counter;
    } catch (error) {
      this.logger.warn(`No se pudo crear account_closures_total: ${(error as Error).message}`);
    }
  }

  /** Suma 1 al resultado; si prom-client falla, solo avisa en el log (nunca lanza). */
  record(result: ClosureResult) {
    try {
      this.closures?.inc({ result });
    } catch (error) {
      this.logger.warn(`No se pudo contar la cancelación (${result}): ${(error as Error).message}`);
    }
  }
}
