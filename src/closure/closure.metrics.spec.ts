import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import { DataSource } from 'typeorm';
import { OutboxService } from '../events/outbox.service';
import { CLOSURE_RESULTS, ClosureMetrics } from '../metrics/closure-metrics';
import { MetricsService } from '../metrics/metrics.service';
import { signTestTicket } from '../testing/closure-ticket.fixture';
import { closureConfig } from '../testing/closure-harness';
import { ClosureRequirementsService } from './closure-requirements.service';
import { ClosureTasksRelayService } from './closure-tasks-relay.service';
import { ClosureService } from './closure.service';
import { ClosureTicketUse } from './entities/closure-ticket-use.entity';

/**
 * account_closures_total (base y servicios simulados, sin PostgreSQL): cada resultado se cuenta una vez, solo el
 * cierre que hizo ESTA solicitud cuenta como completed, y contar nunca rompe un cierre de cuenta.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';

interface FakeClosure {
  idUser: string;
  closedAt: Date;
  accountNumbers: string[];
  ticketJti: string;
}
interface FakeAccount {
  id: string;
  accountNumber: string;
  status: string;
  blockedBy: string | null;
}

function setup(
  accounts: FakeAccount[] = [{ id: 'acc-1', accountNumber: '40000007919', status: 'active', blockedBy: null }],
) {
  const ticketUses = new Map<string, string>(); // jti → idUser
  const closures: FakeClosure[] = [];
  const state = { transactionError: null as unknown };
  const ticketRepo = {
    insert: jest.fn(async ({ jti, idUser }: { jti: string; idUser: string }) => {
      if (ticketUses.has(jti)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      ticketUses.set(jti, idUser);
    }),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const closureRepo = {
    findOne: jest.fn(async ({ where }: { where: { ticketJti?: string; idUser?: string } }) => {
      return (
        closures.find((c) => (where.ticketJti ? c.ticketJti === where.ticketJti : c.idUser === where.idUser)) ?? null
      );
    }),
  };
  const queryBuilder: Record<string, unknown> = {};
  for (const method of ['setLock', 'where', 'andWhere', 'orderBy']) queryBuilder[method] = jest.fn(() => queryBuilder);
  queryBuilder.getMany = jest.fn(async () => accounts);
  const manager = {
    createQueryBuilder: jest.fn(() => queryBuilder),
    findOne: jest.fn(async (_entity: unknown, { where }: { where: { idUser: string } }) => {
      return closures.find((c) => c.idUser === where.idUser) ?? null;
    }),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 0 })),
    create: jest.fn((_entity: unknown, row: FakeClosure) => row),
    save: jest.fn(async (row: FakeClosure) => (closures.push(row), row)),
    insert: jest.fn(async () => ({})),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => (entity === ClosureTicketUse ? ticketRepo : closureRepo)),
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => {
      if (state.transactionError) throw state.transactionError;
      return work(manager);
    }),
  };
  const requirements = { check: jest.fn(async () => ({ puedeCancelar: true, pendientes: [] as unknown[] })) };
  const outbox = { enqueue: jest.fn(async () => undefined), flush: jest.fn(async () => undefined) };
  const tasks = { run: jest.fn(async () => 0) };
  const metricsService = new MetricsService(new ConfigService({}));
  const service = new ClosureService(
    dataSource as unknown as DataSource,
    closureConfig(),
    requirements as unknown as ClosureRequirementsService,
    outbox as unknown as OutboxService,
    tasks as unknown as ClosureTasksRelayService,
    new ClosureMetrics(metricsService),
  );
  const counter = () => metricsService.registry.getSingleMetric('account_closures_total') as Counter;
  const counted = async () => {
    const { values } = await counter().get();
    return Object.fromEntries(values.filter((v) => v.value > 0).map((v) => [v.labels.result, v.value]));
  };
  return { service, ticketRepo, closures, state, requirements, outbox, metricsService, counter, counted };
}

describe('ClosureMetrics', () => {
  it('las 3 series existen desde el arranque en 0 y solo hay la etiqueta result', async () => {
    const metricsService = new MetricsService(new ConfigService({}));
    new ClosureMetrics(metricsService);
    const { values } = await (metricsService.registry.getSingleMetric('account_closures_total') as Counter).get();

    expect(values.map((v) => v.labels.result).sort()).toEqual([...CLOSURE_RESULTS].sort());
    for (const v of values) {
      expect(Object.keys(v.labels)).toEqual(['result']);
      expect(v.value).toBe(0);
    }
  });

  it('record() nunca lanza: si prom-client falla solo avisa en el log', () => {
    const metricsService = new MetricsService(new ConfigService({}));
    const metrics = new ClosureMetrics(metricsService);
    jest
      .spyOn(metricsService.registry.getSingleMetric('account_closures_total') as Counter, 'inc')
      .mockImplementation(() => {
        throw new Error('prom-client roto');
      });
    const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(() => metrics.record('completed')).not.toThrow();

    expect(aviso).toHaveBeenCalledTimes(1);
    aviso.mockRestore();
  });

  it('si la métrica no se pudo crear (nombre duplicado), el servicio arranca y contar no hace nada', () => {
    const metricsService = new MetricsService(new ConfigService({}));
    new ClosureMetrics(metricsService);

    const segunda = new ClosureMetrics(metricsService);

    expect(() => segunda.record('error')).not.toThrow();
  });
});

describe('account_closures_total al cancelar la cuenta', () => {
  describe('completed', () => {
    it('se cuenta una vez cuando esta solicitud cerró las cuentas', async () => {
      const { service, counted, outbox } = setup();

      const result = await service.close(ANA, signTestTicket(ANA));

      expect(result).toMatchObject({ cerrada: true });
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(await counted()).toEqual({ completed: 1 });
    });

    it('repetir el mismo ticket devuelve el mismo cierre y no lo cuenta otra vez', async () => {
      const { service, counted } = setup();
      const ticket = signTestTicket(ANA);

      const first = await service.close(ANA, ticket);
      const again = await service.close(ANA, ticket);

      expect(again).toEqual(first);
      expect(await counted()).toEqual({ completed: 1 });
    });

    it('si otra solicitud ya había cerrado las cuentas (otro ticket a la vez), esta no cuenta', async () => {
      const { service, closures, counted } = setup();
      closures.push({ idUser: ANA, closedAt: new Date(), accountNumbers: ['40000007919'], ticketJti: 'otro-jti' });

      const result = await service.close(ANA, signTestTicket(ANA));

      expect(result.cerrada).toBe(true);
      expect(await counted()).toEqual({});
    });

    it('si el cierre choca con otro por la clave única (23505) y se responde el existente, no cuenta', async () => {
      const { service, closures, state, counted } = setup();
      closures.push({ idUser: ANA, closedAt: new Date(), accountNumbers: [], ticketJti: 'otro-jti' });
      state.transactionError = Object.assign(new Error('duplicate key'), { code: '23505' });

      const result = await service.close(ANA, signTestTicket(ANA));

      expect(result.cerrada).toBe(true);
      expect(await counted()).toEqual({});
    });
  });

  describe('requirements', () => {
    it('si ya no se cumplen los requisitos, no cierra y cuenta requirements (la respuesta lleva los pendientes)', async () => {
      const { service, requirements, ticketRepo, counted } = setup();
      requirements.check.mockResolvedValueOnce({
        puedeCancelar: false,
        pendientes: [{ codigo: 'saldo', cuentaId: 'acc-1', saldo: 250_000 }],
      });

      const error = await service.close(ANA, signTestTicket(ANA)).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().pendientes).toEqual([expect.objectContaining({ codigo: 'saldo', saldo: 250_000 })]);
      expect(ticketRepo.update).toHaveBeenCalledWith(expect.anything(), { result: 'requirements' });
      expect(await counted()).toEqual({ requirements: 1 });
    });

    it('si el banco bloqueó una cuenta después de la revisión, cuenta requirements', async () => {
      const { service, counted } = setup([
        { id: 'acc-1', accountNumber: '40000007919', status: 'blocked', blockedBy: 'bank' },
      ]);

      await expect(service.close(ANA, signTestTicket(ANA))).rejects.toThrow('El banco bloqueó');

      expect(await counted()).toEqual({ requirements: 1 });
    });
  });

  describe('error', () => {
    it('si un servicio no responde al revisar los requisitos, cuenta error', async () => {
      const { service, requirements, ticketRepo, counted } = setup();
      requirements.check.mockRejectedValueOnce(new ServiceUnavailableException('savings caído'));

      await expect(service.close(ANA, signTestTicket(ANA))).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(ticketRepo.update).toHaveBeenCalledWith(expect.anything(), { result: 'error' });
      expect(await counted()).toEqual({ error: 1 });
    });

    it('un error inesperado al cerrar (la base falla) cuenta error', async () => {
      const { service, state, counted } = setup();
      state.transactionError = new Error('la base se cayó');

      await expect(service.close(ANA, signTestTicket(ANA))).rejects.toThrow('la base se cayó');

      expect(await counted()).toEqual({ error: 1 });
    });
  });

  describe('lo que NO se cuenta', () => {
    it('ticket inválido o de otro cliente, ticket ya gastado por otro cliente y servicio sin configurar', async () => {
      const { service, ticketRepo, counted } = setup();
      await expect(service.close(ANA, 'no-es-un-ticket')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.close(ANA, signTestTicket(CARLOS))).rejects.toBeInstanceOf(ForbiddenException);

      // Un ticket ya usado por otra persona: se rechaza sin tocar nada.
      const ticket = signTestTicket(ANA);
      const jti = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString()).jti;
      await ticketRepo.insert({ jti, idUser: CARLOS });
      await expect(service.close(ANA, ticket)).rejects.toBeInstanceOf(ConflictException);

      expect(await counted()).toEqual({});
    });

    it('sin CLOSURE_TICKET_SECRET el servicio responde 503 y no cuenta', async () => {
      const { service, counted } = setup();
      Object.assign(service, { config: { get: () => undefined } as unknown as ConfigService });

      await expect(service.close(ANA, signTestTicket(ANA))).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(await counted()).toEqual({});
    });
  });

  describe('contar nunca rompe un cierre de cuenta', () => {
    it('si contar lanza, las cuentas se cierran igual y el cliente recibe el cierre', async () => {
      const { service, counter, outbox, closures } = setup();
      jest.spyOn(counter(), 'inc').mockImplementation(() => {
        throw new Error('prom-client roto');
      });

      const result = await service.close(ANA, signTestTicket(ANA));

      expect(result.cerrada).toBe(true);
      expect(closures).toHaveLength(1);
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it('si contar lanza, un rechazo llega al cliente con su error original y el ticket queda marcado', async () => {
      const { service, counter, requirements, ticketRepo } = setup();
      jest.spyOn(counter(), 'inc').mockImplementation(() => {
        throw new Error('prom-client roto');
      });
      requirements.check.mockResolvedValueOnce({ puedeCancelar: false, pendientes: [{ codigo: 'saldo' }] });

      const error = await service.close(ANA, signTestTicket(ANA)).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(ticketRepo.update).toHaveBeenCalledWith(expect.anything(), { result: 'requirements' });
    });

    it('si el servicio de métricas falla del todo (record lanza), el cierre tampoco se rompe', async () => {
      const { service, closures } = setup();
      Object.assign(service, {
        metrics: {
          record: () => {
            throw new Error('métrica dañada');
          },
        },
      });

      await expect(service.close(ANA, signTestTicket(ANA))).resolves.toMatchObject({ cerrada: true });

      expect(closures).toHaveLength(1);
    });
  });

  describe('etiquetas: lista cerrada, sin datos sensibles', () => {
    it('tras cierres con ids, números de cuenta y pendientes con saldos, la métrica solo tiene result de la lista cerrada', async () => {
      const { service, requirements, metricsService } = setup();
      requirements.check.mockResolvedValueOnce({
        puedeCancelar: false,
        pendientes: [{ codigo: 'saldo', cuentaId: 'acc-1', saldo: 250_000, mensaje: 'Tienes $250.000 en 40000007919' }],
      });
      await service.close(ANA, signTestTicket(ANA)).catch(() => undefined);
      await service.close(ANA, signTestTicket(ANA));

      const text = await metricsService.registry.metrics();
      const lineas = text.split('\n').filter((l) => l.startsWith('account_closures_total'));
      const etiquetas = lineas.map((l) => l.slice(l.indexOf('{'), l.indexOf('}') + 1)).join(' ');

      expect(lineas).toHaveLength(CLOSURE_RESULTS.length);
      for (const dato of [ANA, CARLOS, 'acc-1', '40000007919', '250', 'saldo', 'Tienes']) {
        expect(etiquetas).not.toContain(dato);
      }
      for (const m of etiquetas.matchAll(/result="([^"]+)"/g)) expect(CLOSURE_RESULTS).toContain(m[1]);
      expect([...etiquetas.matchAll(/(\w+)="/g)].map((m) => m[1])).toEqual(
        Array(CLOSURE_RESULTS.length).fill('result'),
      );
    });
  });
});
