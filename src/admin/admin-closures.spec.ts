import { ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AccountClosure } from '../closure/entities/account-closure.entity';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffPrincipal, StaffRole } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { CLOSURE_ENTITIES, seedAccount } from '../testing/closure-harness';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import request = require('supertest');

const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const staff = (role: StaffRole): StaffPrincipal => ({
  id: `staff-${role}`,
  username: `${role}.prueba`,
  role,
  docHash: null,
  issuedAt: null,
});

/** Datos de cierre en el panel de cuentas, contra PostgreSQL. */
describeWithDb('Panel de cuentas: cuentas cerradas (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let admin: AdminAccountsService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('account_admin', CLOSURE_ENTITIES));
    admin = new AdminAccountsService(
      dataSource.getRepository(Account),
      dataSource.getRepository(AccountClosure),
      new AdminAuditService(dataSource.getRepository(AdminAudit)),
    );
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const auditRows = () => dataSource.getRepository(AdminAudit).find({ order: { createdAt: 'ASC' } });
  const CLOSED_AT = new Date('2026-10-20T15:00:00.000Z');

  /** Ana canceló desde la app (2 cuentas) y además tenía una que el banco cerró antes; Carlos: cerrada por el banco. */
  async function seed() {
    const anaApp1 = await seedAccount(dataSource, ANA, { status: 'closed', closedAt: CLOSED_AT });
    const anaApp2 = await seedAccount(dataSource, ANA, { status: 'closed', closedAt: CLOSED_AT });
    const anaBanco = await seedAccount(dataSource, ANA, { status: 'closed', closedAt: new Date('2026-09-01') });
    const carlos = await seedAccount(dataSource, CARLOS, { status: 'closed', closedAt: new Date('2026-10-22') });
    const activa = await seedAccount(dataSource, CARLOS);
    await dataSource.getRepository(AccountClosure).insert({
      idUser: ANA,
      closedAt: CLOSED_AT,
      accountNumbers: [anaApp1.accountNumber!, anaApp2.accountNumber!],
      ticketJti: '9a000000-0000-4000-8000-000000000001',
    });
    return { anaApp1, anaApp2, anaBanco, carlos, activa };
  }

  describe('Listado', () => {
    it.each<StaffRole>(['compliance', 'admin'])(
      '%s filtra las cerradas: fecha y quién la cerró, y queda en la bitácora',
      async (role) => {
        const { anaApp1, anaApp2, anaBanco, carlos } = await seed();
        const result = await admin.list(staff(role), undefined, 'closed');

        expect(result.total).toBe(4);
        const byId = new Map(result.items.map((a) => [a.id, a]));
        expect(byId.get(anaApp1.id)).toMatchObject({ cerradaPor: 'cliente', closedAt: CLOSED_AT });
        expect(byId.get(anaApp2.id)).toMatchObject({ cerradaPor: 'cliente' });
        expect(byId.get(anaBanco.id)).toMatchObject({ cerradaPor: 'banco' });
        expect(byId.get(carlos.id)).toMatchObject({ cerradaPor: 'banco' });

        const [row] = await auditRows();
        expect(row).toMatchObject({
          action: 'account_closure.list_viewed',
          staffRole: role,
          staffUsername: `${role}.prueba`,
          targetType: 'account',
          targetId: 'listado',
        });
        expect((row.details as { cuentas: string[] }).cuentas.sort()).toEqual(
          [anaApp1.id, anaApp2.id, anaBanco.id, carlos.id].sort(),
        );
      },
    );

    it('soporte no puede filtrar las cerradas (403) y no queda nada en la bitácora', async () => {
      await seed();
      await expect(admin.list(staff('support'), undefined, 'closed')).rejects.toBeInstanceOf(ForbiddenException);
      expect(await auditRows()).toHaveLength(0);
    });

    it('soporte, sin filtro, no recibe la fecha de cierre ni quién la cerró', async () => {
      await seed();
      const result = await admin.list(staff('support'));
      expect(result.total).toBe(5);
      for (const item of result.items) {
        expect(item).not.toHaveProperty('closedAt');
        expect(item).not.toHaveProperty('cerradaPor');
      }
      expect(await auditRows()).toHaveLength(0);
    });

    it('una página sin cuentas cerradas no se registra', async () => {
      await seed();
      const result = await admin.list(staff('compliance'), undefined, 'active');
      expect(result.items).toEqual([expect.objectContaining({ status: 'active', cerradaPor: null })]);
      expect(await auditRows()).toHaveLength(0);
    });
  });

  describe('Detalle', () => {
    it('cumplimiento ve el cierre de una cuenta y queda en la bitácora', async () => {
      const { anaApp1 } = await seed();
      expect(await admin.detail(anaApp1.id, staff('compliance'))).toMatchObject({
        status: 'closed',
        cerradaPor: 'cliente',
        closedAt: CLOSED_AT,
      });
      expect(await auditRows()).toEqual([
        expect.objectContaining({ action: 'account_closure.viewed', targetType: 'account', targetId: anaApp1.id }),
      ]);
    });

    it('soporte ve la cuenta sin los datos de cierre; una cuenta activa no se registra', async () => {
      const { anaApp1, activa } = await seed();
      expect(await admin.detail(anaApp1.id, staff('support'))).not.toHaveProperty('cerradaPor');
      expect(await admin.detail(activa.id, staff('compliance'))).not.toHaveProperty('cerradaPor');
      expect(await auditRows()).toHaveLength(0);
    });
  });

  describe('Cierre del cliente (ficha)', () => {
    it('devuelve fecha, cuentas y origen, y queda en la bitácora', async () => {
      const { anaApp1, anaApp2 } = await seed();
      expect(await admin.closure(ANA, staff('admin'))).toEqual({
        idUser: ANA,
        cerradaEn: CLOSED_AT,
        cuentas: [anaApp1.accountNumber, anaApp2.accountNumber],
        cerradaPor: 'cliente',
      });
      expect(await auditRows()).toEqual([
        expect.objectContaining({ action: 'account_closure.viewed', targetType: 'account_closure', targetId: ANA }),
      ]);
    });

    it('un cliente que no canceló desde la app: 404 y sin registro', async () => {
      await seed();
      await expect(admin.closure(CARLOS, staff('compliance'))).rejects.toBeInstanceOf(NotFoundException);
      expect(await auditRows()).toHaveLength(0);
    });
  });
});

describe('Panel de cuentas: permisos por rol de /accounts/admin/closures (HTTP)', () => {
  const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
  const jwt = new JwtService({});
  const admin = {
    closure: jest.fn().mockResolvedValue({ idUser: ANA }),
    list: jest.fn().mockResolvedValue({ items: [] }),
  };
  let app: INestApplication;
  const token = (role: StaffRole) =>
    `Bearer ${jwt.sign({ sub: `staff-${role}`, type: 'staff', role, username: role }, { secret: SECRET })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAccountsController],
      providers: [
        StaffAuthGuard,
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'STAFF_JWT_SECRET' ? SECRET : undefined) } },
        { provide: AdminAccountsService, useValue: admin },
        { provide: AdminAuditService, useValue: { record: jest.fn(), list: jest.fn() } },
        { provide: EventConsumerService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('soporte recibe 403', async () => {
    await request(app.getHttpServer())
      .get(`/accounts/admin/closures/${ANA}`)
      .set('Authorization', token('support'))
      .expect(403);
    expect(admin.closure).not.toHaveBeenCalled();
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s la consulta con su usuario', async (role) => {
    await request(app.getHttpServer())
      .get(`/accounts/admin/closures/${ANA}`)
      .set('Authorization', token(role))
      .expect(200);
    expect(admin.closure).toHaveBeenCalledWith(ANA, expect.objectContaining({ role }));
  });

  it('un id que no es UUID responde 400', async () => {
    await request(app.getHttpServer())
      .get('/accounts/admin/closures/no-es-uuid')
      .set('Authorization', token('admin'))
      .expect(400);
    expect(admin.closure).not.toHaveBeenCalled();
  });

  it('el listado recibe quién consulta (para el filtro de cerradas)', async () => {
    await request(app.getHttpServer())
      .get('/accounts/admin/accounts?status=closed')
      .set('Authorization', token('support'))
      .expect(200);
    expect(admin.list).toHaveBeenCalledWith(expect.objectContaining({ role: 'support' }), undefined, 'closed', 1, 25);
  });
});
