import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AccountsService } from '../accounts/accounts.service';
import { Account } from '../accounts/entities/account.entity';
import { IdentityVerification } from '../accounts/entities/identity-verification.entity';
import { AccountOutbox } from '../events/account-outbox.entity';
import { BrebKey } from '../keys/entities/breb-key.entity';
import { signTestTicket, signTestToken, TEST_CLOSURE_SECRET } from '../testing/closure-ticket.fixture';
import { buildClosure, CLOSURE_ENTITIES, fakeClients, FakeClients, seedAccount } from '../testing/closure-harness';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { ClosureService } from './closure.service';
import { AccountClosure } from './entities/account-closure.entity';
import { ClosureTask } from './entities/closure-task.entity';
import { BALANCE_CHECK_DELAY_MS } from './closure-tasks-relay.service';
import { ClosureTicketUse } from './entities/closure-ticket-use.entity';

const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';

/** Cancelar la cuenta: ticket de un solo uso, requisitos al cerrar y lo que queda guardado. */
describeWithDb('Cancelar la cuenta en account-service (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let clients: FakeClients;
  let service: ClosureService;
  let relayKick: { run: jest.Mock };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_cierre', CLOSURE_ENTITIES));
  });

  afterAll(async () => {
    await drop();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    clients = fakeClients();
    ({ service, relayKick } = buildClosure(dataSource, clients));
  });

  const count = (entity: Parameters<DataSource['getRepository']>[0]) => dataSource.getRepository(entity).count();
  const statusOf = async (id: string) => (await dataSource.getRepository(Account).findOneByOrFail({ id })).status;
  const ticketResult = async (ticket: string) => {
    const jti = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString()).jti;
    return (await dataSource.getRepository(ClosureTicketUse).findOneByOrFail({ jti })).result;
  };

  describe('Cierre', () => {
    it('cierra todas las cuentas del cliente, libera sus llaves y guarda el evento y las tareas posteriores', async () => {
      const principal = await seedAccount(dataSource, ANA);
      const bloqueadaPorElla = await seedAccount(dataSource, ANA, { status: 'blocked', blockedBy: 'user' });
      const deCarlos = await seedAccount(dataSource, CARLOS);
      await dataSource.getRepository(BrebKey).save([
        { idUser: ANA, type: 'celular', key: '3001234567', accountId: principal.id, holderName: 'Ana••• Gó•••' },
        { idUser: CARLOS, type: 'celular', key: '3109876543', accountId: deCarlos.id, holderName: 'Car••• Pé•••' },
      ] as BrebKey[]);

      const result = await service.close(ANA, signTestTicket(ANA));

      expect(result.cerrada).toBe(true);
      expect(result.cuentas.sort()).toEqual([principal.accountNumber, bloqueadaPorElla.accountNumber].sort());
      const cuentasAna = await dataSource.getRepository(Account).findBy({ idUser: ANA });
      for (const cuenta of cuentasAna) {
        expect(cuenta.status).toBe('closed');
        expect(cuenta.closedAt?.toISOString()).toBe(result.cerradaEn);
      }
      expect(await statusOf(deCarlos.id)).toBe('active');
      expect(await dataSource.getRepository(BrebKey).findBy({ idUser: ANA })).toHaveLength(0);
      expect(await dataSource.getRepository(BrebKey).findBy({ idUser: CARLOS })).toHaveLength(1);

      const events = await dataSource.getRepository(AccountOutbox).find();
      expect(events).toHaveLength(1);
      expect(events[0].routingKey).toBe('account.closed');
      expect(events[0].publishedAt).toBeNull();
      expect(events[0].payload).toEqual({ idUser: ANA, cerradaEn: result.cerradaEn, cuentas: result.cuentas });

      const tasks = await dataSource.getRepository(ClosureTask).find({ order: { kind: 'ASC' } });
      expect(tasks.map((t) => t.kind)).toEqual(['auth_access', 'balance_check']);
      const cerradaEn = new Date(result.cerradaEn).getTime();
      for (const t of tasks) {
        expect(t).toMatchObject({ idUser: ANA, attempts: 0, doneAt: null });
        expect(t.closedAt.getTime()).toBe(cerradaEn);
      }
      // Auth: de inmediato. Saldo: un rato después, cuando ya terminó lo que estaba en curso.
      expect(tasks[0].nextAttemptAt.getTime()).toBe(cerradaEn);
      expect(tasks[1].nextAttemptAt.getTime()).toBe(cerradaEn + BALANCE_CHECK_DELAY_MS);
      expect(relayKick.run).toHaveBeenCalled();
    });

    it('quien canceló no puede abrir otra cuenta', async () => {
      await seedAccount(dataSource, ANA);
      await service.close(ANA, signTestTicket(ANA));
      const accounts = new AccountsService(
        dataSource.getRepository(Account),
        dataSource.getRepository(IdentityVerification),
        dataSource.getRepository(AccountClosure),
      );
      await expect(accounts.create({ idUser: ANA, currency: 'COP' } as any, ANA)).rejects.toThrow(
        'Tu cuenta Banklite fue cancelada.',
      );
    });
  });

  describe('Ticket de un solo uso', () => {
    it('reenviar el mismo ticket devuelve el mismo cierre, sin un segundo evento ni tareas repetidas', async () => {
      await seedAccount(dataSource, ANA);
      const ticket = signTestTicket(ANA);

      const first = await service.close(ANA, ticket);
      const again = await service.close(ANA, ticket);

      expect(again).toEqual(first);
      expect(await count(AccountClosure)).toBe(1);
      expect(await count(AccountOutbox)).toBe(1);
      expect(await count(ClosureTask)).toBe(2);
      // La repetición no volvió a revisar requisitos: el ticket no se procesó dos veces.
      expect(clients.fraudSummary).toHaveBeenCalledTimes(1);
    });

    it('con el mismo ticket enviado 5 veces a la vez, se cierra una sola vez', async () => {
      await seedAccount(dataSource, ANA);
      const ticket = signTestTicket(ANA);

      const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.close(ANA, ticket)));

      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(ConflictException);
      expect(clients.fraudSummary).toHaveBeenCalledTimes(1);
      expect(await count(ClosureTicketUse)).toBe(1);
      expect(await count(AccountClosure)).toBe(1);
      expect(await count(AccountOutbox)).toBe(1);
      expect(await count(ClosureTask)).toBe(2);
    });

    it('dos tickets distintos a la vez: un solo cierre, un solo evento y un solo par de tareas', async () => {
      await seedAccount(dataSource, ANA);

      const results = await Promise.allSettled([
        service.close(ANA, signTestTicket(ANA)),
        service.close(ANA, signTestTicket(ANA)),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const [a, b] = results as PromiseFulfilledResult<{ cerradaEn: string }>[];
      expect(a.value.cerradaEn).toBe(b.value.cerradaEn);
      expect(await count(AccountClosure)).toBe(1);
      expect(await count(AccountOutbox)).toBe(1);
      expect(await count(ClosureTask)).toBe(2);
    });

    it('un ticket que ya se gastó en un intento rechazado no sirve después, aunque ya se cumplan los requisitos', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      const ticket = signTestTicket(ANA);
      clients.balances.set(cuenta.id, 15_000);
      await expect(service.close(ANA, ticket)).rejects.toBeInstanceOf(ConflictException);

      clients.balances.set(cuenta.id, 0);
      await expect(service.close(ANA, ticket)).rejects.toThrow('Esta confirmación ya se usó.');
      expect(await statusOf(cuenta.id)).toBe('active');
      expect(await count(AccountClosure)).toBe(0);
    });

    it('rechaza tickets vencidos, de otro cliente, con otro secreto o con forma de token de acceso, sin gastarlos', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      const now = Math.floor(Date.now() / 1000);
      const invalid = [
        signTestTicket(ANA, {}, TEST_CLOSURE_SECRET, Date.now() - 6 * 60 * 1000),
        signTestTicket(CARLOS),
        signTestTicket(ANA, {}, 'c3'.repeat(32)),
        signTestToken({ sub: ANA, type: 'access', jti: randomUUID(), iat: now, exp: now + 900 }, TEST_CLOSURE_SECRET),
        signTestTicket(ANA, { aud: 'auth-service' }),
      ];
      for (const ticket of invalid) {
        await expect(service.close(ANA, ticket)).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(await count(ClosureTicketUse)).toBe(0);
      expect(await statusOf(cuenta.id)).toBe('active');
    });
  });

  describe('Requisitos al momento de cerrar', () => {
    it('si después de la revisión llegó saldo, no cierra y dice qué falta', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      const antes = await service.requisitos(ANA);
      expect(antes.puedeCancelar).toBe(true);

      // Entre la pantalla de requisitos y la confirmación entra una transferencia.
      clients.balances.set(cuenta.id, 250_000);
      const ticket = signTestTicket(ANA);
      const error = await service.close(ANA, ticket).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().pendientes).toEqual([
        expect.objectContaining({ codigo: 'saldo', cuentaId: cuenta.id, saldo: 250_000 }),
      ]);
      expect(clients.balance).toHaveBeenLastCalledWith(cuenta.id);
      expect(await statusOf(cuenta.id)).toBe('active');
      expect(await ticketResult(ticket)).toBe('requirements');
      expect(await count(AccountOutbox)).toBe(0);
      expect(await count(ClosureTask)).toBe(0);
    });

    it('si se abrió una revisión de seguridad o una recarga entre tanto, tampoco cierra', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      clients.fraudSummary.mockResolvedValueOnce({ alertasAbiertas: 1, sinPendientes: false });
      const ticket = signTestTicket(ANA);
      const error = await service.close(ANA, ticket).catch((e) => e);
      expect(error.getResponse().pendientes.map((p: any) => p.codigo)).toEqual(['revision_seguridad']);
      expect(await ticketResult(ticket)).toBe('requirements');

      clients.depositsSummary.mockResolvedValueOnce({
        recargasPendientes: 1,
        recargasEnRevision: 0,
        sinPendientes: false,
      });
      const error2 = await service.close(ANA, signTestTicket(ANA)).catch((e) => e);
      expect(error2.getResponse().pendientes.map((p: any) => p.codigo)).toEqual(['recargas_pendientes']);
      expect(await statusOf(cuenta.id)).toBe('active');
    });

    it('si un servicio no responde, no cierra (nunca asume que está todo bien)', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      clients.savingsSummary.mockRejectedValueOnce(new ServiceUnavailableException('savings caído'));
      const ticket = signTestTicket(ANA);
      await expect(service.close(ANA, ticket)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await statusOf(cuenta.id)).toBe('active');
      expect(await ticketResult(ticket)).toBe('error');
      expect(await count(AccountOutbox)).toBe(0);
    });

    it('si el banco bloqueó una cuenta después de la revisión, no cierra', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      // La revisión ve la cuenta activa; justo después el panel la bloquea.
      clients.fraudSummary.mockImplementationOnce(async () => {
        await dataSource.getRepository(Account).update(cuenta.id, { status: 'blocked', blockedBy: 'bank' });
        return { alertasAbiertas: 0, sinPendientes: true };
      });
      await expect(service.close(ANA, signTestTicket(ANA))).rejects.toThrow('El banco bloqueó');
      expect(await statusOf(cuenta.id)).toBe('blocked');
      expect(await count(AccountClosure)).toBe(0);
    });

    it('lista todo lo que falta, con mensajes para el cliente', async () => {
      const cuenta = await seedAccount(dataSource, ANA);
      await seedAccount(dataSource, ANA, { status: 'blocked', blockedBy: 'bank' });
      clients.balances.set(cuenta.id, 1_500);
      clients.savingsSummary.mockResolvedValueOnce({
        bolsillosConDinero: 2,
        metasConDinero: 1,
        saldoApartado: 90_000,
        cdtsVigentes: 1,
        operacionesEnProceso: 1,
        sinPendientes: false,
      });
      clients.depositsSummary.mockResolvedValueOnce({
        recargasPendientes: 0,
        recargasEnRevision: 1,
        sinPendientes: false,
      });

      const req = await service.requisitos(ANA);

      expect(req.puedeCancelar).toBe(false);
      expect(req.cuentas).toHaveLength(2);
      expect(req.pendientes.map((p) => p.codigo)).toEqual([
        'saldo',
        'bloqueo_banco',
        'bolsillos',
        'metas',
        'cdt',
        'ahorro_en_proceso',
        'recargas_en_revision',
      ]);
      expect(req.pendientes[0].mensaje).toContain(`····${cuenta.accountNumber!.slice(-4)}`);
      expect(req.pendientes[2].mensaje).toBe('Tienes 2 bolsillos con dinero. Pásalo a tu cuenta antes de cancelar.');
      // Nunca se le dice al cliente que tiene una alerta de fraude.
      expect(JSON.stringify(req)).not.toMatch(/fraude/i);
    });

    it('si un servicio dice que hay algo pendiente que no conocemos, igual bloquea', async () => {
      await seedAccount(dataSource, ANA);
      clients.depositsSummary.mockResolvedValueOnce({
        recargasPendientes: 0,
        recargasEnRevision: 0,
        sinPendientes: false,
      });
      const req = await service.requisitos(ANA);
      expect(req.puedeCancelar).toBe(false);
      expect(req.pendientes.map((p) => p.codigo)).toEqual(['operacion_en_proceso']);
    });
  });
});
