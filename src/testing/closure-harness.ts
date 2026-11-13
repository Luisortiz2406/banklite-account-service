import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ClosureClientsService } from '../closure/closure-clients.service';
import { ClosureRequirementsService } from '../closure/closure-requirements.service';
import { ClosureTasksRelayService } from '../closure/closure-tasks-relay.service';
import { ClosureService } from '../closure/closure.service';
import { ENTITIES } from '../entities';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { ClosureMetrics } from '../metrics/closure-metrics';
import { MetricsService } from '../metrics/metrics.service';
import { TEST_CLOSURE_SECRET } from './closure-ticket.fixture';

// Todas las tablas del servicio, igual que en producción.
export const CLOSURE_ENTITIES = ENTITIES;

/** Respuestas de los otros servicios, configurables en cada prueba. */
export function fakeClients() {
  const balances = new Map<string, number>();
  const clients = {
    balances,
    balance: jest.fn(async (accountId: string) => balances.get(accountId) ?? 0),
    savingsSummary: jest.fn(async () => ({
      bolsillosConDinero: 0,
      metasConDinero: 0,
      saldoApartado: 0,
      cdtsVigentes: 0,
      operacionesEnProceso: 0,
      sinPendientes: true,
    })),
    depositsSummary: jest.fn(async () => ({ recargasPendientes: 0, recargasEnRevision: 0, sinPendientes: true })),
    fraudSummary: jest.fn(async () => ({ alertasAbiertas: 0, sinPendientes: true })),
    // null = auth confirmó; un texto = la falla.
    closeAccessInAuth: jest.fn(async (): Promise<string | null> => null),
  };
  return clients;
}
export type FakeClients = ReturnType<typeof fakeClients>;

export function closureConfig(secret: string | undefined = TEST_CLOSURE_SECRET) {
  return { get: (key: string) => (key === 'CLOSURE_TICKET_SECRET' ? secret : undefined) } as unknown as ConfigService;
}

/**
 * ClosureService con las dependencias reales sobre la base de prueba; solo se
 * simulan las llamadas HTTP. RabbitMQ "caído": los eventos quedan en el outbox.
 * El relevo de tareas que dispara el cierre es un stub; las pruebas del relevo
 * crean el suyo para controlar cuándo corre.
 */
export function buildClosure(dataSource: DataSource, clients: FakeClients) {
  const requirements = new ClosureRequirementsService(
    dataSource.getRepository(Account),
    clients as unknown as ClosureClientsService,
  );
  const outbox = new OutboxService(dataSource, { isReady: () => false } as unknown as EventPublisherService);
  const relayKick = { run: jest.fn(async () => 0) };
  // Métricas reales (sin abrir el puerto): las pruebas leen lo que se publicaría en /metrics.
  const metricsService = new MetricsService(new ConfigService({}));
  const service = new ClosureService(
    dataSource,
    closureConfig(),
    requirements,
    outbox,
    relayKick as unknown as ClosureTasksRelayService,
    new ClosureMetrics(metricsService),
  );
  return { service, requirements, relayKick, metricsService };
}

let accountCounter = 0;
export async function seedAccount(dataSource: DataSource, idUser: string, overrides: Partial<Account> = {}) {
  accountCounter += 1;
  const repo = dataSource.getRepository(Account);
  return repo.save(
    repo.create({
      idUser,
      accountNumber: String(40_000_000_000 + accountCounter * 7919),
      accountType: 'savings',
      currency: 'COP',
      status: 'active',
      blockedBy: null,
      dailyLimit: 5_000_000,
      monthlyLimit: 50_000_000,
      ...overrides,
    }),
  );
}
