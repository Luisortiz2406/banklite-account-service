import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { IdentityVerification } from '../accounts/entities/identity-verification.entity';
import { EventConsumerService } from './event-consumer.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Consumidor de identity.verified (RabbitMQ simulado): al verificarse la identidad se
 * guarda la verificación y se activa la cuenta pendiente. Lo que falle va a reintento o a la DLQ.
 */
const QUEUE = 'account-service.identity-verified';
const ANA = '11111111-1111-4111-8111-111111111111';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = { connection: {}, channel: {} };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn().mockResolvedValue({ messageCount: 0, consumerCount: 1 }),
    get: jest.fn().mockResolvedValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}
const delivery = (body: unknown) =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey: 'identity.verified' },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

describe('EventConsumerService de account', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  const verifications = { upsert: jest.fn() };
  const accounts = { update: jest.fn() };

  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventConsumerService(
      new ConfigService(env),
      verifications as unknown as Repository<IdentityVerification>,
      accounts as unknown as Repository<Account>,
    );
  const started = async (service = build()) => {
    await service.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0][1] as (msg: amqplib.ConsumeMessage | null) => Promise<void>;
    return { service, onMessage };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    verifications.upsert.mockResolvedValue(undefined);
    accounts.update.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('sin RABBITMQ_URL no intenta conectar; con ella se suscribe solo a identity.verified, con reintentos y DLQ', async () => {
    await build({}).onModuleInit();
    expect(connect).not.toHaveBeenCalled();

    await started();
    expect(broker.channel.bindQueue).toHaveBeenCalledTimes(1);
    expect(broker.channel.bindQueue).toHaveBeenCalledWith(QUEUE, 'banklite.events', 'identity.verified');
    expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
  });

  it('al verificarse la identidad guarda la verificación y activa la cuenta que estaba pendiente', async () => {
    const { onMessage } = await started();
    const msg = delivery({ event: 'identity.verified', data: { idUser: ANA } });

    await onMessage(msg);

    expect(verifications.upsert).toHaveBeenCalledWith({ idUser: ANA, verified: true }, ['idUser']);
    expect(accounts.update).toHaveBeenCalledWith({ idUser: ANA, status: 'pending' }, { status: 'active' });
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('solo activa cuentas pendientes (el filtro lo lleva la consulta); una repetición del evento es inofensiva', async () => {
    const { onMessage } = await started();

    await onMessage(delivery({ data: { idUser: ANA } }));
    await onMessage(delivery({ data: { idUser: ANA } }));

    expect(accounts.update.mock.calls.every((call) => call[0].status === 'pending')).toBe(true);
    expect(broker.channel.ack).toHaveBeenCalledTimes(2);
  });

  it('sin idUser se descarta (se confirma para no bloquear la cola)', async () => {
    const { onMessage } = await started();
    const msg = delivery({ data: {} });

    await onMessage(msg);

    expect(verifications.upsert).not.toHaveBeenCalled();
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('un mensaje que no es JSON va a la DLQ; si la base falla, a la cola de espera para reintentar', async () => {
    const { onMessage } = await started();

    await onMessage(delivery('esto no es json'));
    expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);

    verifications.upsert.mockRejectedValueOnce(new Error('base caída'));
    await onMessage(delivery({ data: { idUser: ANA } }));
    expect(broker.channel.sendToQueue.mock.calls[1][0]).toBe(`${QUEUE}.retry`);
    expect(accounts.update).not.toHaveBeenCalled();

    await onMessage(null);
  });

  it('reconecta a los 5 s si RabbitMQ no está o se cae, y cerrar el módulo cancela el reintento', async () => {
    jest.useFakeTimers();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const service = build();
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);

    broker.handlers.connection.close();
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(() => broker.handlers.connection.error(new Error('x'))).not.toThrow();
    expect(() => broker.handlers.channel.error(new Error('x'))).not.toThrow();
  });

  it('panel de la DLQ: sin conexión no deja listar ni reencolar; conectado informa la cola', async () => {
    const offline = build({});
    expect(await offline.deadLetterStats()).toEqual({ connected: false });
    await expect(offline.peekDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');
    await expect(offline.requeueDeadLetters(5)).rejects.toThrow('RabbitMQ no está conectado');

    const { service } = await started();
    expect(await service.deadLetterStats()).toMatchObject({ connected: true, queue: QUEUE });
    expect(await service.peekDeadLetters(5)).toEqual([]);
    expect(await service.requeueDeadLetters(5)).toEqual({ moved: 0 });
  });
});
