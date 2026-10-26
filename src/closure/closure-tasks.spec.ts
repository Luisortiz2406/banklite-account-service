import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { buildClosure, CLOSURE_ENTITIES, fakeClients, FakeClients, seedAccount } from '../testing/closure-harness';
import { signTestTicket } from '../testing/closure-ticket.fixture';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { ClosureAlertsService } from './closure-alerts.service';
import { ClosureClientsService } from './closure-clients.service';
import { BALANCE_CHECK_DELAY_MS, ClosureTasksRelayService, retryDelayMs } from './closure-tasks-relay.service';
import { ClosureBalanceAlert } from './entities/closure-balance-alert.entity';
import { ClosureTask, ClosureTaskKind } from './entities/closure-task.entity';

const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const SECOND = 1000;
const COMPLIANCE: StaffPrincipal = {
  id: 'staff-7',
  username: 'cumplimiento.ana',
  role: 'compliance',
  docHash: null,
  issuedAt: null,
};

describe('Espera entre reintentos de las tareas del cierre', () => {
  it('crece al doble con cada falla y se queda en 1 hora', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([10 * SECOND, 20 * SECOND, 40 * SECOND, 80 * SECOND]);
    expect(retryDelayMs(30)).toBe(60 * 60 * SECOND);
  });
});

/** Tareas después del cierre (closure_tasks): guardadas en la base, con reintentos que sobreviven a un reinicio. */
describeWithDb('Tareas después de cancelar la cuenta (PostgreSQL)', () => {
  let dataSource: DataSource;
  // La conexión que creó createTestDatabase: drop() la cierra antes de borrar la base.
  let original: DataSource;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_tareas', CLOSURE_ENTITIES));
    original = dataSource;
  });

  afterAll(async () => {
    // Después del "reinicio" la conexión vigente es otra: se cierra y se reabre la original.
    if (dataSource !== original) {
      await dataSource.destroy();
      await original.initialize();
    }
    await drop();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  const relayWith = (ds: DataSource, clients: FakeClients) =>
    new ClosureTasksRelayService(ds, clients as unknown as ClosureClientsService);
  const task = (ds: DataSource, kind: ClosureTaskKind) =>
    ds.getRepository(ClosureTask).findOneByOrFail({ idUser: ANA, kind });
  const alerts = () => dataSource.getRepository(ClosureBalanceAlert).find();

  /**
   * Cancela la cuenta de Ana como lo haría el cliente. Con `only`, deja solo esa
   * tarea, para probarla sin que la otra corra en la misma pasada.
   */
  async function closeAna(only?: ClosureTaskKind) {
    const cuenta = await seedAccount(dataSource, ANA);
    const { service } = buildClosure(dataSource, fakeClients());
    const { cerradaEn } = await service.close(ANA, signTestTicket(ANA));
    if (only)
      await dataSource
        .getRepository(ClosureTask)
        .delete({ idUser: ANA, kind: only === 'auth_access' ? 'balance_check' : 'auth_access' });
    return { closedAt: new Date(cerradaEn), cuenta };
  }

  describe('Cerrar el acceso en auth', () => {
    it('si auth no responde, reintenta con espera creciente y retoma después de un reinicio', async () => {
      const { closedAt } = await closeAna('auth_access');
      const t0 = new Date(closedAt.getTime() + 1);

      // Antes del reinicio: auth está caído.
      const authDown = fakeClients();
      authDown.closeAccessInAuth.mockResolvedValue('Auth Service no respondió (red o tiempo agotado).');
      const before = relayWith(dataSource, authDown);

      expect(await before.run(t0)).toBe(0);
      let saved = await task(dataSource, 'auth_access');
      expect(saved).toMatchObject({ attempts: 1, doneAt: null, lastError: expect.stringContaining('no respondió') });
      expect(saved.nextAttemptAt.getTime()).toBe(t0.getTime() + 10 * SECOND);

      // Todavía no toca: no llama a auth.
      await before.run(new Date(t0.getTime() + 5 * SECOND));
      expect(authDown.closeAccessInAuth).toHaveBeenCalledTimes(1);

      const t1 = new Date(t0.getTime() + 10 * SECOND);
      await before.run(t1);
      saved = await task(dataSource, 'auth_access');
      expect(saved.attempts).toBe(2);
      expect(saved.nextAttemptAt.getTime()).toBe(t1.getTime() + 20 * SECOND);

      // Reinicio: se detiene el relevo y se cierra la conexión. Nada queda en memoria.
      before.onModuleDestroy();
      const options = dataSource.options;
      await dataSource.destroy();
      dataSource = new DataSource(options);
      await dataSource.initialize();

      // Después del reinicio auth ya responde.
      const authUp = fakeClients();
      const after = relayWith(dataSource, authUp);

      // La espera guardada se respeta también después del reinicio.
      expect(await after.run(new Date(t1.getTime() + 19 * SECOND))).toBe(0);
      expect(authUp.closeAccessInAuth).not.toHaveBeenCalled();

      expect(await after.run(new Date(t1.getTime() + 20 * SECOND))).toBe(1);
      expect(authUp.closeAccessInAuth).toHaveBeenCalledWith(ANA, closedAt);
      saved = await task(dataSource, 'auth_access');
      expect(saved).toMatchObject({ attempts: 3, lastError: null });
      expect(saved.doneAt).not.toBeNull();

      // Hecha: no se vuelve a llamar.
      await after.run(new Date(t1.getTime() + 60 * 60 * SECOND));
      expect(authUp.closeAccessInAuth).toHaveBeenCalledTimes(1);
    });

    it('un rechazo de auth (p. ej. clave interna mal configurada) también se reintenta', async () => {
      const { closedAt } = await closeAna('auth_access');
      const clients = fakeClients();
      clients.closeAccessInAuth.mockResolvedValueOnce('Auth Service respondió 401: Clave interna inválida');
      const relay = relayWith(dataSource, clients);

      await relay.run(new Date(closedAt.getTime() + 1));
      expect((await task(dataSource, 'auth_access')).doneAt).toBeNull();

      await relay.run(new Date(closedAt.getTime() + 11 * SECOND));
      expect((await task(dataSource, 'auth_access')).doneAt).not.toBeNull();
      expect(clients.closeAccessInAuth).toHaveBeenCalledTimes(2);
    });

    it('con dos réplicas corriendo a la vez, auth recibe una sola llamada por tarea', async () => {
      const { closedAt } = await closeAna('auth_access');
      const clients = fakeClients();
      clients.closeAccessInAuth.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return null;
      });
      const now = new Date(closedAt.getTime() + 1);

      const done = await Promise.all([
        relayWith(dataSource, clients).run(now),
        relayWith(dataSource, clients).run(now),
      ]);

      expect(done.sort()).toEqual([0, 1]);
      expect(clients.closeAccessInAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe('Revisar el saldo después del cierre', () => {
    it('si después del cierre llegó dinero, abre la alerta «cuenta cerrada con saldo» (una sola vez)', async () => {
      const { closedAt, cuenta } = await closeAna('balance_check');
      // Una transferencia que leyó la cuenta como activa terminó justo después del cierre.
      const clients = fakeClients();
      clients.balances.set(cuenta.id, 75_000);
      const relay = relayWith(dataSource, clients);

      // Antes de los 30 s no consulta: puede haber movimientos todavía en curso.
      await relay.run(new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS - 1));
      expect(clients.balance).not.toHaveBeenCalled();

      expect(await relay.run(new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS))).toBe(1);
      expect(clients.balance).toHaveBeenCalledWith(cuenta.id);
      const [alert] = await alerts();
      expect(alert).toMatchObject({
        idUser: ANA,
        accountId: cuenta.id,
        accountNumber: cuenta.accountNumber,
        currency: 'COP',
        status: 'open',
      });
      expect(Number(alert.balance)).toBe(75_000);
      expect(alert.closedAt.getTime()).toBe(closedAt.getTime());
      expect((await task(dataSource, 'balance_check')).doneAt).not.toBeNull();

      // Si la revisión se repite (p. ej. se cayó antes de guardar que terminó), no duplica la alerta.
      await dataSource.getRepository(ClosureTask).update({ idUser: ANA, kind: 'balance_check' }, { doneAt: null });
      await relay.run(new Date(closedAt.getTime() + 2 * BALANCE_CHECK_DELAY_MS));
      expect(await alerts()).toHaveLength(1);
    });

    it('con saldo en $0 no abre alerta', async () => {
      const { closedAt } = await closeAna('balance_check');
      await relayWith(dataSource, fakeClients()).run(new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS));
      expect(await alerts()).toHaveLength(0);
      expect((await task(dataSource, 'balance_check')).doneAt).not.toBeNull();
    });

    it('si el ledger no responde, reintenta más tarde (no da la revisión por hecha)', async () => {
      const { closedAt, cuenta } = await closeAna('balance_check');
      const due = new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS);
      const clients = fakeClients();
      clients.balance.mockRejectedValueOnce(new ServiceUnavailableException('ledger caído'));
      clients.balances.set(cuenta.id, 10_000);
      const relay = relayWith(dataSource, clients);

      await relay.run(due);
      const saved = await task(dataSource, 'balance_check');
      expect(saved).toMatchObject({ attempts: 1, doneAt: null, lastError: expect.stringContaining('ledger caído') });
      expect(await alerts()).toHaveLength(0);

      await relay.run(new Date(due.getTime() + 10 * SECOND));
      expect(await alerts()).toHaveLength(1);
    });

    it('solo revisa las cuentas que cerró este cierre', async () => {
      // Cuenta que el banco cerró antes (otra fecha) y cuenta de otro cliente: no se consultan.
      const vieja = await seedAccount(dataSource, ANA, {
        status: 'closed',
        closedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const deCarlos = await seedAccount(dataSource, CARLOS);
      const { closedAt, cuenta } = await closeAna('balance_check');
      const clients = fakeClients();

      await relayWith(dataSource, clients).run(new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS));

      expect(clients.balance.mock.calls.map((c) => c[0])).toEqual([cuenta.id]);
      expect(clients.balance).not.toHaveBeenCalledWith(vieja.id);
      expect(clients.balance).not.toHaveBeenCalledWith(deCarlos.id);
    });
  });

  describe('Alertas en el panel (cumplimiento)', () => {
    async function openAlert(balance = 75_000) {
      const { closedAt, cuenta } = await closeAna('balance_check');
      const clients = fakeClients();
      clients.balances.set(cuenta.id, balance);
      await relayWith(dataSource, clients).run(new Date(closedAt.getTime() + BALANCE_CHECK_DELAY_MS));
      const service = new ClosureAlertsService(
        dataSource,
        clients as unknown as ClosureClientsService,
        new AdminAuditService(dataSource.getRepository(AdminAudit)),
      );
      return { service, clients, cuenta, alert: (await alerts())[0] };
    }

    it('lista las alertas abiertas con su saldo y cuántas hay', async () => {
      const { service, cuenta } = await openAlert();
      const result = await service.list();
      expect(result.abiertas).toBe(1);
      expect(result.items).toEqual([
        expect.objectContaining({ accountId: cuenta.id, balance: 75_000, status: 'open', idUser: ANA }),
      ]);
      expect((await service.list('resolved')).items).toHaveLength(0);
    });

    it('no se resuelve mientras la cuenta tenga saldo; después queda resuelta, con quién y en la bitácora', async () => {
      const { service, clients, cuenta, alert } = await openAlert();

      await expect(service.resolve(alert.id, 'Reverso del movimiento entrante', COMPLIANCE)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((await alerts())[0].status).toBe('open');

      // Cumplimiento reversa el movimiento: la cuenta vuelve a $0.
      clients.balances.set(cuenta.id, 0);
      const resolved = await service.resolve(alert.id, 'Reverso del movimiento entrante', COMPLIANCE);
      expect(resolved).toMatchObject({
        status: 'resolved',
        resolvedBy: 'cumplimiento.ana',
        resolutionNote: 'Reverso del movimiento entrante',
      });
      expect((await service.list()).abiertas).toBe(0);

      const audit = await dataSource.getRepository(AdminAudit).find();
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'closure_alert.resolved',
          targetId: cuenta.id,
          staffUsername: 'cumplimiento.ana',
        }),
      ]);

      await expect(service.resolve(alert.id, 'Otra vez', COMPLIANCE)).rejects.toBeInstanceOf(ConflictException);
    });

    it('la cuenta sigue cerrada: la alerta no la reabre', async () => {
      const { cuenta } = await openAlert();
      expect((await dataSource.getRepository(Account).findOneByOrFail({ id: cuenta.id })).status).toBe('closed');
    });
  });
});
