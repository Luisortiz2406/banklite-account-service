import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { IdentityVerification } from '../accounts/entities/identity-verification.entity';
import { AuthAccessRelayService } from '../closure/auth-access-relay.service';
import { ClosureClientsService } from '../closure/closure-clients.service';
import { ClosureRequirementsService } from '../closure/closure-requirements.service';
import { ClosureService } from '../closure/closure.service';
import { AccountClosure } from '../closure/entities/account-closure.entity';
import { AuthAccessTask } from '../closure/entities/auth-access-task.entity';
import { ClosureTicketUse } from '../closure/entities/closure-ticket-use.entity';
import { AccountOutbox } from '../events/account-outbox.entity';
import { EventPublisherService } from '../events/event-publisher.service';
import { OutboxService } from '../events/outbox.service';
import { BrebKey } from '../keys/entities/breb-key.entity';
import { TEST_CLOSURE_SECRET } from './closure-ticket.fixture';

export const CLOSURE_ENTITIES = [
  Account,
  IdentityVerification,
  BrebKey,
  AccountClosure,
  ClosureTicketUse,
  AuthAccessTask,
  AccountOutbox,
];

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
 * El relevo de auth que dispara el cierre es un stub; las pruebas del relevo
 * crean el suyo para controlar cuándo corre.
 */
export function buildClosure(dataSource: DataSource, clients: FakeClients) {
  const requirements = new ClosureRequirementsService(
    dataSource.getRepository(Account),
    clients as unknown as ClosureClientsService,
  );
  const outbox = new OutboxService(dataSource, { isReady: () => false } as unknown as EventPublisherService);
  const relayKick = { run: jest.fn(async () => 0) };
  const service = new ClosureService(
    dataSource,
    closureConfig(),
    requirements,
    outbox,
    relayKick as unknown as AuthAccessRelayService,
  );
  return { service, requirements, relayKick };
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
