import { DataSource } from 'typeorm';
import { buildClosure, CLOSURE_ENTITIES, fakeClients, seedAccount } from '../testing/closure-harness';
import { signTestTicket } from '../testing/closure-ticket.fixture';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AuthAccessRelayService, retryDelayMs } from './auth-access-relay.service';
import { ClosureClientsService } from './closure-clients.service';
import { AuthAccessTask } from './entities/auth-access-task.entity';

const ANA = '11111111-1111-4111-8111-111111111111';
const SECOND = 1000;

describe('Espera entre reintentos hacia auth', () => {
  it('crece al doble con cada falla y se queda en 1 hora', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([10 * SECOND, 20 * SECOND, 40 * SECOND, 80 * SECOND]);
    expect(retryDelayMs(30)).toBe(60 * 60 * SECOND);
  });
});

/** Cerrar el acceso en auth: tarea guardada en la base, con reintentos que sobreviven a un reinicio. */
describeWithDb('Cierre del acceso en auth (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_relay', CLOSURE_ENTITIES));
  });

  afterAll(async () => {
    if (!dataSource.isInitialized) await dataSource.initialize();
    await drop();
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  const relayWith = (ds: DataSource, clients: ReturnType<typeof fakeClients>) =>
    new AuthAccessRelayService(ds, clients as unknown as ClosureClientsService);
  const task = (ds: DataSource) => ds.getRepository(AuthAccessTask).findOneByOrFail({ idUser: ANA });

  /** Cancela la cuenta de Ana como lo haría el cliente y devuelve la fecha de cierre. */
  async function closeAna() {
    await seedAccount(dataSource, ANA);
    const { service } = buildClosure(dataSource, fakeClients());
    const { cerradaEn } = await service.close(ANA, 'token', signTestTicket(ANA));
    return new Date(cerradaEn);
  }

  it('si auth no responde, reintenta con espera creciente y retoma después de un reinicio', async () => {
    const closedAt = await closeAna();
    const t0 = new Date(closedAt.getTime() + 1);

    // Antes del reinicio: auth está caído.
    const authDown = fakeClients();
    authDown.closeAccessInAuth.mockResolvedValue('Auth Service no respondió (red o tiempo agotado).');
    const before = relayWith(dataSource, authDown);

    expect(await before.run(t0)).toBe(0);
    let saved = await task(dataSource);
    expect(saved).toMatchObject({ attempts: 1, doneAt: null, lastError: expect.stringContaining('no respondió') });
    expect(saved.nextAttemptAt.getTime()).toBe(t0.getTime() + 10 * SECOND);

    // Todavía no toca: no llama a auth.
    await before.run(new Date(t0.getTime() + 5 * SECOND));
    expect(authDown.closeAccessInAuth).toHaveBeenCalledTimes(1);

    const t1 = new Date(t0.getTime() + 10 * SECOND);
    await before.run(t1);
    saved = await task(dataSource);
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
    saved = await task(dataSource);
    expect(saved).toMatchObject({ attempts: 3, lastError: null });
    expect(saved.doneAt).not.toBeNull();

    // Hecha: no se vuelve a llamar.
    await after.run(new Date(t1.getTime() + 60 * 60 * SECOND));
    expect(authUp.closeAccessInAuth).toHaveBeenCalledTimes(1);
  });

  it('un rechazo de auth (p. ej. clave interna mal configurada) también se reintenta', async () => {
    const closedAt = await closeAna();
    const clients = fakeClients();
    clients.closeAccessInAuth.mockResolvedValueOnce('Auth Service respondió 401: Clave interna inválida');
    const relay = relayWith(dataSource, clients);

    await relay.run(new Date(closedAt.getTime() + 1));
    expect((await task(dataSource)).doneAt).toBeNull();

    await relay.run(new Date(closedAt.getTime() + 11 * SECOND));
    expect((await task(dataSource)).doneAt).not.toBeNull();
    expect(clients.closeAccessInAuth).toHaveBeenCalledTimes(2);
  });

  it('con dos réplicas corriendo a la vez, auth recibe una sola llamada por tarea', async () => {
    const closedAt = await closeAna();
    const clients = fakeClients();
    clients.closeAccessInAuth.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return null;
    });
    const now = new Date(closedAt.getTime() + 1);

    const done = await Promise.all([relayWith(dataSource, clients).run(now), relayWith(dataSource, clients).run(now)]);

    expect(done.sort()).toEqual([0, 1]);
    expect(clients.closeAccessInAuth).toHaveBeenCalledTimes(1);
  });
});
