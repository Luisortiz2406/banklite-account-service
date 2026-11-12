import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { AccountClosure } from '../closure/entities/account-closure.entity';
import { ENTITIES } from '../entities';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AccountsService, MERCHANT_OWNER_ID } from './accounts.service';
import { Account } from './entities/account.entity';
import { IdentityVerification } from './entities/identity-verification.entity';

/**
 * Apertura, límites y estado de las cuentas contra PostgreSQL real. Lo que importa: nadie
 * abre cuentas a nombre de otro, quien canceló no abre otra, los límites nunca superan los
 * regulatorios, y un bloqueo del banco no lo levanta el cliente.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';

describeWithDb('AccountsService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let accounts: Repository<Account>;
  let service: AccountsService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_service', ENTITIES));
    accounts = dataSource.getRepository(Account);
    service = new AccountsService(
      accounts,
      dataSource.getRepository(IdentityVerification),
      dataSource.getRepository(AccountClosure),
    );
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    jest.restoreAllMocks();
  });

  const verify = (idUser: string) =>
    dataSource.getRepository(IdentityVerification).save({ idUser, verified: true, receivedAt: new Date() });
  const open = (idUser = ANA, extra: Record<string, unknown> = {}) =>
    service.create({ idUser, currency: 'COP', ...extra } as never, idUser);
  const make = (overrides: Partial<Account> = {}) =>
    accounts.save(
      accounts.create({
        idUser: ANA,
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

  describe('abrir una cuenta', () => {
    it('queda activa si la identidad ya se verificó, con número de 11 dígitos y los límites por defecto', async () => {
      await verify(ANA);

      const account = await open();

      expect(account).toMatchObject({ idUser: ANA, status: 'active', accountType: 'savings', currency: 'COP' });
      // numeric de Postgres vuelve como texto ('5000000.00'): se compara como número.
      expect([Number(account.dailyLimit), Number(account.monthlyLimit)]).toEqual([5_000_000, 50_000_000]);
      expect(account.accountNumber).toMatch(/^\d{11}$/);
    });

    it('sin identidad verificada queda pendiente (y se activa cuando llega identity.verified)', async () => {
      expect((await open()).status).toBe('pending');
    });

    it('nadie abre una cuenta a nombre de otra persona', async () => {
      await expect(service.create({ idUser: CARLOS, currency: 'COP' } as never, ANA)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(await accounts.count()).toBe(0);
    });

    it('quien canceló su cuenta Banklite no puede abrir otra', async () => {
      await dataSource
        .getRepository(AccountClosure)
        .save({ idUser: ANA, closedAt: new Date(), accountNumbers: ['10000000001'], ticketJti: randomUUID() });

      await expect(open()).rejects.toThrow('Tu cuenta Banklite fue cancelada');
      expect(await accounts.count()).toBe(0);
    });

    it('el cliente puede pedir límites más bajos, pero no más altos que los regulatorios, ni un diario mayor al mensual', async () => {
      await verify(ANA);

      const lower = await open(ANA, { dailyLimit: 1_000_000, monthlyLimit: 10_000_000 });
      expect([Number(lower.dailyLimit), Number(lower.monthlyLimit)]).toEqual([1_000_000, 10_000_000]);
      await expect(open(ANA, { dailyLimit: 5_000_001 })).rejects.toThrow('límites máximos permitidos');
      await expect(open(ANA, { monthlyLimit: 50_000_001 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(open(ANA, { dailyLimit: 2_000_000, monthlyLimit: 1_000_000 })).rejects.toThrow(
        'diario no puede superar',
      );
      expect(await accounts.count()).toBe(1);
    });

    it('si el número generado ya existe, lo intenta de nuevo; si falla siempre, informa el error', async () => {
      const duplicated = Object.assign(new Error('duplicate key'), { code: '23505' });
      const save = jest.spyOn(accounts, 'save').mockRejectedValueOnce(duplicated);
      expect(await open()).toBeDefined();
      expect(save).toHaveBeenCalledTimes(2);

      save.mockReset().mockRejectedValue(duplicated);
      await expect(open()).rejects.toBe(duplicated);
      expect(save).toHaveBeenCalledTimes(5);

      save.mockReset().mockRejectedValue(new Error('base caída'));
      await expect(open()).rejects.toThrow('base caída');
    });

    it('los números de cuenta no se repiten entre cuentas', async () => {
      const numbers = new Set<string>();
      for (let i = 0; i < 25; i++) numbers.add((await open(randomUUID())).accountNumber!);
      expect(numbers.size).toBe(25);
    });
  });

  describe('cuentas de comercio', () => {
    it('crea la cuenta del comercio sin límites de salida, a nombre del dueño de sistema', async () => {
      const merchant = await service.ensureMerchant({ code: 'netflix', name: 'Cineluz' });

      expect(merchant).toMatchObject({
        merchantCode: 'netflix',
        merchantName: 'Cineluz',
        currency: 'COP',
        status: 'active',
      });
      const row = await accounts.findOneByOrFail({ id: merchant.id });
      expect(row).toMatchObject({ idUser: MERCHANT_OWNER_ID, accountType: 'merchant' });
      expect([Number(row.dailyLimit), Number(row.monthlyLimit)]).toEqual([0, 0]);
    });

    it('es idempotente por código: pedirla otra vez devuelve la misma', async () => {
      const first = await service.ensureMerchant({ code: 'netflix', name: 'Cineluz', currency: 'USD' });
      const again = await service.ensureMerchant({ code: 'netflix', name: 'Otro nombre' });

      expect(again.id).toBe(first.id);
      expect(again.currency).toBe('USD');
      expect(await accounts.countBy({ accountType: 'merchant' })).toBe(1);
    });

    it('si otra instancia la crea al mismo tiempo (clave única), devuelve la ganadora', async () => {
      const winner = await service.ensureMerchant({ code: 'spotify', name: 'Ritmia' });
      const duplicated = Object.assign(new Error('duplicate key'), { code: '23505' });
      jest.spyOn(accounts, 'findOne').mockResolvedValueOnce(null);
      jest.spyOn(accounts, 'save').mockRejectedValueOnce(duplicated);

      const raced = await service.ensureMerchant({ code: 'spotify', name: 'Ritmia' });

      expect(raced.id).toBe(winner.id);
    });
  });

  describe('consultas', () => {
    it('lista solo las cuentas propias, de la más antigua a la más reciente', async () => {
      const first = await make();
      const second = await make();
      await make({ idUser: CARLOS });

      expect((await service.listForUser(ANA)).map((a) => a.id)).toEqual([first.id, second.id]);
    });

    it('una cuenta antigua sin número recibe uno al consultarla', async () => {
      const legacy = await make({ accountNumber: null });

      const [listed] = await service.listForUser(ANA);

      expect(listed.id).toBe(legacy.id);
      expect(listed.accountNumber).toMatch(/^\d{11}$/);
      expect((await accounts.findOneByOrFail({ id: legacy.id })).accountNumber).toBe(listed.accountNumber);
    });

    it('los límites y el detalle son solo del titular; una cuenta inexistente da 404', async () => {
      const account = await make({ dailyLimit: 1_000_000, monthlyLimit: 8_000_000 });

      expect(await service.getLimits(account.id, ANA)).toEqual({
        accountId: account.id,
        currency: 'COP',
        dailyLimit: 1_000_000,
        monthlyLimit: 8_000_000,
      });
      expect((await service.findOne(account.id, ANA)).id).toBe(account.id);
      await expect(service.getLimits(account.id, CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.findOne(account.id, CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getLimits(randomUUID(), ANA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.findOne(randomUUID(), ANA)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('para el ledger: datos de la cuenta por id y por número (11 dígitos), con los límites como número', async () => {
      const account = await make({ accountNumber: '10000000099', dailyLimit: 2_000_000 });

      expect(await service.findLedgerInfo(account.id)).toEqual({
        id: account.id,
        accountNumber: '10000000099',
        accountType: 'savings',
        idUser: ANA,
        currency: 'COP',
        status: 'active',
        dailyLimit: 2_000_000,
        monthlyLimit: 50_000_000,
      });
      expect((await service.findLedgerInfoByNumber('10000000099')).id).toBe(account.id);
      await expect(service.findLedgerInfo(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.findLedgerInfoByNumber('123')).rejects.toThrow('11 dígitos');
      await expect(service.findLedgerInfoByNumber('10000000000')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cambiar el estado', () => {
    it('el titular puede bloquear y desbloquear su cuenta (queda anotado quién la bloqueó)', async () => {
      const account = await make();

      const blocked = await service.updateStatus(account.id, { status: 'blocked' }, ANA);
      expect(blocked).toMatchObject({ status: 'blocked', blockedBy: 'user' });

      const active = await service.updateStatus(account.id, { status: 'active' }, ANA);
      expect(active).toMatchObject({ status: 'active', blockedBy: null });
    });

    it('un bloqueo del banco no lo levanta el titular', async () => {
      const account = await make({ status: 'blocked', blockedBy: 'bank' });

      await expect(service.updateStatus(account.id, { status: 'active' }, ANA)).rejects.toThrow(
        'bloqueada por el banco',
      );
      expect((await accounts.findOneByOrFail({ id: account.id })).status).toBe('blocked');
    });

    it('un bloqueo anterior a la columna (sin blockedBy) lo puede levantar el titular', async () => {
      const account = await make({ status: 'blocked', blockedBy: null });
      expect((await service.updateStatus(account.id, { status: 'active' }, ANA)).status).toBe('active');
    });

    it('una cuenta pendiente no se activa a mano ni se bloquea', async () => {
      const account = await make({ status: 'pending' });

      await expect(service.updateStatus(account.id, { status: 'active' }, ANA)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.updateStatus(account.id, { status: 'blocked' }, ANA)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('una cuenta cerrada no se modifica, el mismo estado no cambia nada, y solo el titular opera', async () => {
      const closed = await make({ status: 'closed' });
      await expect(service.updateStatus(closed.id, { status: 'active' }, ANA)).rejects.toThrow('cuenta cerrada');

      const active = await make();
      expect((await service.updateStatus(active.id, { status: 'active' }, ANA)).status).toBe('active');
      await expect(service.updateStatus(active.id, { status: 'blocked' }, CARLOS)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.updateStatus(randomUUID(), { status: 'blocked' }, ANA)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
