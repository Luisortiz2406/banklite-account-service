import { randomUUID } from 'crypto';
import { BadRequestException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ENTITIES } from '../entities';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { BrebKey } from './entities/breb-key.entity';
import { KeysClientsService } from './keys-clients.service';
import { KeysService } from './keys.service';

/**
 * Llaves Banklite contra PostgreSQL real (KYC y auth simulados). Lo que importa: solo se
 * registra el celular, el correo o el documento propios (verificados en KYC), registrar
 * o borrar exige la clave dinámica, y una llave de una cuenta inactiva no se resuelve.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'token-del-cliente';
const profile = {
  nombres: 'Laura',
  apellidos: 'Gómez',
  numeroDocumento: '1.020.304.050',
  email: 'Laura@Banklite.Test',
  telefono: '+57 300 123 4567',
};

describeWithDb('KeysService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let accounts: Repository<Account>;
  let keys: Repository<BrebKey>;
  let service: KeysService;
  const clients = { kycProfile: jest.fn(), verifyDynamicKey: jest.fn() };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_keys', ENTITIES));
    accounts = dataSource.getRepository(Account);
    keys = dataSource.getRepository(BrebKey);
    service = new KeysService(keys, accounts, clients as unknown as KeysClientsService);
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.restoreAllMocks();
    clients.kycProfile.mockReset().mockResolvedValue(profile);
    clients.verifyDynamicKey.mockReset().mockResolvedValue(undefined);
  });

  const account = (idUser = ANA, overrides: Partial<Account> = {}) =>
    accounts.save(
      accounts.create({
        idUser,
        accountNumber: String(10_000_000_000 + Math.floor(Math.random() * 1_000_000_000)),
        accountType: 'savings',
        currency: 'COP',
        status: 'active',
        dailyLimit: 5_000_000,
        monthlyLimit: 50_000_000,
        blockedBy: null,
        ...overrides,
      }),
    );
  const register = (
    type: 'celular' | 'correo' | 'documento' | 'alfanumerica',
    raw: string,
    idUser = ANA,
    code = '123456',
  ) => service.register(idUser, TOKEN, type, raw, code);

  describe('registrar', () => {
    it('registra el celular propio (aunque KYC lo guarde con +57) y llega a la cuenta activa del cliente', async () => {
      const first = await account();

      const result = await register('celular', '300 123 4567');

      expect(result.accountNumber).toBe(first.accountNumber);
      expect(result.keys).toEqual([
        expect.objectContaining({ type: 'celular', key: '3001234567', maskedKey: '300 ••• 4567' }),
      ]);
      expect(clients.verifyDynamicKey).toHaveBeenCalledWith(ANA, '123456');
      expect(await keys.findOneByOrFail({ key: '3001234567' })).toMatchObject({
        accountId: first.id,
        holderName: 'Lau•• Góm••',
      });
    });

    it('registra el correo (en minúsculas) y el documento propios', async () => {
      await account();

      await register('correo', 'LAURA@banklite.test');
      const result = await register('documento', '1020304050');

      expect(result.keys.map((k) => [k.type, k.key])).toEqual([
        ['correo', 'laura@banklite.test'],
        ['documento', '1020304050'],
      ]);
    });

    it('solo se registran los datos propios: otro celular, correo o documento da 403 y no gasta la clave dinámica', async () => {
      await account();

      await expect(register('celular', '3109999999')).rejects.toThrow('celular que verificaste');
      await expect(register('correo', 'otro@banklite.test')).rejects.toThrow('correo que verificaste');
      await expect(register('documento', '9999999999')).rejects.toThrow('tu propio número de documento');
      expect(clients.verifyDynamicKey).not.toHaveBeenCalled();
      expect(await keys.count()).toBe(0);
    });

    it('la llave personalizada no necesita coincidir con KYC, pero sí ser válida', async () => {
      await account();

      expect((await register('alfanumerica', '@Laura99')).keys[0]).toMatchObject({ key: '@laura99' });
      await expect(register('celular', 'no-es-un-celular')).rejects.toThrow(
        'Esa no es una llave válida de tipo celular',
      );
      await expect(register('correo', '3001234567')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una clave dinámica incorrecta no registra nada', async () => {
      await account();
      clients.verifyDynamicKey.mockRejectedValue(new BadRequestException('Clave dinámica incorrecta o vencida.'));

      await expect(register('celular', '3001234567')).rejects.toThrow('Clave dinámica incorrecta');
      expect(await keys.count()).toBe(0);
    });

    it('exige una cuenta activa de persona; una cuenta de comercio o bloqueada no sirve', async () => {
      await expect(register('celular', '3001234567')).rejects.toThrow('cuenta Banklite activa');
      await account(ANA, { status: 'blocked' });
      await account(ANA, { accountType: 'merchant' });
      await expect(register('celular', '3001234567')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una sola llave por tipo, y una llave no se repite entre personas', async () => {
      await account();
      await account(CARLOS);
      await register('alfanumerica', '@laura99');

      await expect(register('alfanumerica', '@otra99')).rejects.toThrow(
        'Ya tienes una llave de tipo llave personalizada',
      );
      await expect(register('alfanumerica', '@laura99', CARLOS)).rejects.toThrow('ya está registrada por otra persona');
    });

    it('si dos peticiones registran la misma llave a la vez, la segunda recibe un conflicto claro', async () => {
      await account();
      jest.spyOn(keys, 'save').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
      await expect(register('alfanumerica', '@laura99')).rejects.toThrow('acaba de ser registrada');

      jest.spyOn(keys, 'save').mockRejectedValueOnce(new Error('base caída'));
      await expect(register('alfanumerica', '@laura99')).rejects.toThrow('base caída');
    });

    it('el nombre del titular se guarda enmascarado, y sin perfil de KYC se usa uno genérico', async () => {
      await account();
      clients.kycProfile.mockResolvedValue({ email: 'laura@banklite.test' });

      await register('correo', 'laura@banklite.test');

      expect((await keys.findOneByOrFail({ type: 'correo' })).holderName).toBe('Cliente Banklite');
    });
  });

  describe('listar y borrar', () => {
    it('lista las llaves del cliente, enmascaradas, junto a la cuenta a la que llegan', async () => {
      const own = await account();
      await register('alfanumerica', '@laura99');
      await account(CARLOS);

      expect(await service.list(ANA)).toMatchObject({
        accountNumber: own.accountNumber,
        keys: [expect.objectContaining({ key: '@laura99' })],
      });
      expect(await service.list(CARLOS)).toMatchObject({ keys: [] });
      expect(await service.list(randomUUID())).toEqual({ accountNumber: null, keys: [] });
    });

    it('borrar exige la clave dinámica y que la llave exista', async () => {
      await account();
      await register('alfanumerica', '@laura99');

      await expect(service.remove(ANA, 'celular', '123456')).rejects.toBeInstanceOf(NotFoundException);
      clients.verifyDynamicKey.mockRejectedValueOnce(new BadRequestException('Clave dinámica incorrecta o vencida.'));
      await expect(service.remove(ANA, 'alfanumerica', '000000')).rejects.toThrow('Clave dinámica incorrecta');
      expect(await keys.count()).toBe(1);

      const result = await service.remove(ANA, 'alfanumerica', '123456');
      expect(result.keys).toEqual([]);
      expect(await keys.count()).toBe(0);
    });
  });

  describe('consultar', () => {
    it('quien busca ve a nombre de quién está la llave (enmascarado) y si es suya', async () => {
      await account();
      await account(CARLOS);
      await register('alfanumerica', '@laura99');

      expect(await service.lookup(CARLOS, ' @LAURA99 ')).toEqual({
        type: 'alfanumerica',
        key: '@laura99',
        maskedKey: '@laura99',
        holderName: 'Lau•• Góm••',
        entity: 'Banklite',
        own: false,
      });
      expect((await service.lookup(ANA, '@laura99')).own).toBe(true);
    });

    it('una llave inexistente, con formato inválido o de una cuenta inactiva no se encuentra', async () => {
      const own = await account();
      await register('alfanumerica', '@laura99');

      await expect(service.lookup(CARLOS, '@nadie99')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.lookup(CARLOS, 'basura')).rejects.toBeInstanceOf(BadRequestException);
      await accounts.update(own.id, { status: 'blocked' });
      await expect(service.lookup(CARLOS, '@laura99')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('entre servicios (transfer) resuelve la cuenta destino de la llave, pero no si la cuenta no está activa', async () => {
      const own = await account();
      await register('alfanumerica', '@laura99');

      expect(await service.resolveInternal('@LAURA99')).toEqual({
        key: '@laura99',
        type: 'alfanumerica',
        idUser: ANA,
        accountId: own.id,
        accountNumber: own.accountNumber,
        holderName: 'Lau•• Góm••',
      });
      await expect(service.resolveInternal('basura')).rejects.toThrow('formato válido');
      await expect(service.resolveInternal('@nadie99')).rejects.toBeInstanceOf(NotFoundException);
      await accounts.update(own.id, { status: 'closed' });
      await expect(service.resolveInternal('@laura99')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('KeysClientsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const KEY = 'clave-interna-de-account-para-pruebas-0123';
  const reply = (status: number, body: unknown = {}) =>
    Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);
  const build = (env: Record<string, string> = {}) =>
    new KeysClientsService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
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

  it('el perfil de KYC se pide con el token del propio cliente; sin verificación de identidad dice qué hacer', async () => {
    fetchMock.mockReturnValueOnce(reply(200, profile));
    expect(await build({ KYC_SERVICE_URL: 'http://kyc.interno:3003' }).kycProfile('u/1', 'tok')).toEqual(profile);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://kyc.interno:3003/kyc/u%2F1');
    expect(init.headers.Authorization).toBe('Bearer tok');

    fetchMock.mockReturnValueOnce(reply(404, {}));
    expect((await failure(build().kycProfile('u1', 'tok'))).message).toBe(
      'Primero completa la verificación de identidad.',
    );

    fetchMock.mockReturnValue(reply(503));
    expect(await failure(build().kycProfile('u1', 'tok'))).toBeInstanceOf(ServiceUnavailableException);
  });

  it('la clave dinámica se valida en auth con la clave interna; incorrecta es 400 y auth caído es 503', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { valid: true }));
    await expect(build().verifyDynamicKey('u1', '123456')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/internal/dynamic-key/verify');
    expect(init.headers['x-internal-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({ idUser: 'u1', code: '123456' });

    fetchMock.mockReturnValueOnce(reply(200, { valid: false, message: 'La clave dinámica venció.' }));
    expect((await failure(build().verifyDynamicKey('u1', '000000'))).message).toBe('La clave dinámica venció.');
    fetchMock.mockReturnValueOnce(reply(200, {}));
    expect((await failure(build().verifyDynamicKey('u1', '000000'))).message).toBe(
      'Clave dinámica incorrecta o vencida.',
    );
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await failure(build().verifyDynamicKey('u1', '123456'))).toBeInstanceOf(ServiceUnavailableException);
  });

  it('sin INTERNAL_API_KEY no se llama a auth', async () => {
    const clients = new KeysClientsService(new ConfigService({}));
    expect(await failure(clients.verifyDynamicKey('u1', '123456'))).toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
