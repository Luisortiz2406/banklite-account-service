import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClosureClientsService } from './closure-clients.service';

/**
 * Llamadas de la cancelación de la cuenta (saldo en el ledger, resumen de ahorro, recargas
 * y fraude, y cierre del acceso en auth). Regla: si algo no responde o dice algo raro,
 * NO se puede cancelar; nunca se asume que está todo bien.
 */
const KEY = 'clave-interna-de-account-para-pruebas-0123';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('ClosureClientsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = {}) =>
    new ClosureClientsService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('no lanzó excepción');
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('el saldo viene del ledger por la red interna con la clave de account, con el id codificado', async () => {
    fetchMock.mockReturnValue(reply(200, { balance: 12_500.5 }));

    expect(await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006/' }).balance('a/1')).toBe(12_500.5);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ledger.interno:3006/ledger/internal/accounts/a%2F1/balance');
    expect(init.headers['x-internal-key']).toBe(KEY);
  });

  it('un saldo que no es un número, o un ledger que falla, impide cancelar (503)', async () => {
    for (const body of [{ balance: 'mucho' }, {}]) {
      fetchMock.mockReturnValueOnce(reply(200, body));
      const error = await failure(build().balance('a1'));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toContain('No pudimos revisar todo lo necesario para cancelar tu cuenta');
    }
    fetchMock.mockReturnValue(reply(503));
    expect(await failure(build().balance('a1'))).toBeInstanceOf(ServiceUnavailableException);
  });

  it('el resumen de ahorro, recargas y fraude se pide a cada servicio con el id del cliente', async () => {
    fetchMock.mockImplementation(() => reply(200, { sinPendientes: true }));
    const clients = build();

    await clients.savingsSummary('u 1');
    await clients.depositsSummary('u 1');
    await clients.fraudSummary('u 1');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://localhost:3013/internal/savings/users/u%201/resumen-cierre',
      'http://localhost:3014/internal/deposits/users/u%201/resumen-cierre',
      'http://localhost:3009/internal/fraud/users/u%201/resumen-cierre',
    ]);
  });

  it('si un servicio no reconoce a account (403) o no tiene la ruta (404) es un error de configuración: 503, no un rechazo al cliente', async () => {
    for (const status of [403, 404, 401]) {
      fetchMock.mockReturnValueOnce(reply(status, { message: 'no' }));
      expect(await failure(build().fraudSummary('u1'))).toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('sin INTERNAL_API_KEY no se consulta nada', async () => {
    const clients = new ClosureClientsService(new ConfigService({}));

    expect(await failure(clients.balance('a1'))).toBeInstanceOf(ServiceUnavailableException);
    expect(await failure(clients.savingsSummary('u1'))).toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('cerrar el acceso en auth', () => {
    const closedAt = new Date('2026-11-11T15:00:00.000Z');

    it('devuelve null si salió bien, y manda el usuario y la fecha del cierre', async () => {
      fetchMock.mockReturnValue(reply(200));

      expect(await build().closeAccessInAuth('u1', closedAt)).toBeNull();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3001/internal/auth/cierre-acceso');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ idUser: 'u1', cerradaEn: '2026-11-11T15:00:00.000Z' });
    });

    it('no lanza: devuelve el motivo de la falla para que el relevo lo guarde y reintente', async () => {
      fetchMock.mockReturnValueOnce(reply(500, { message: 'boom' }));
      expect(await build().closeAccessInAuth('u1', closedAt)).toBe('Auth Service respondió 500: boom');

      fetchMock.mockReturnValueOnce(reply(502, {}));
      expect(await build().closeAccessInAuth('u1', closedAt)).toBe('Auth Service respondió 502: sin mensaje');

      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await build().closeAccessInAuth('u1', closedAt)).toBe('Auth Service no respondió (red o tiempo agotado).');

      expect(await new ClosureClientsService(new ConfigService({})).closeAccessInAuth('u1', closedAt)).toContain(
        'INTERNAL_API_KEY no está configurada',
      );
    });
  });
});
