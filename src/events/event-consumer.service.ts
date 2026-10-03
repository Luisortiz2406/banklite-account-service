import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as amqplib from 'amqplib';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { IdentityVerification } from '../accounts/entities/identity-verification.entity';
import { assertRetryQueues, handleFailure, PoisonMessageError } from './retry-policy';

const RECONNECT_DELAY_MS = 5000;

/**
 * Se suscribe al evento 'identity.verified' publicado por el Identity Service
 * (3.3 Microservicio de Cuentas — "Eventos que consume: identity.verified").
 *
 * Si RabbitMQ no está disponible al iniciar, o se cae después, reintenta en
 * segundo plano sin bloquear el arranque del servicio ni sus endpoints REST.
 *
 * Si un evento falla al procesarse (p. ej. la base de datos no responde), se
 * reintenta varias veces con espera y, si sigue fallando, queda en la DLQ
 * (<cola>.dlq) en lugar de perderse. Ver retry-policy.ts.
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[account-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(IdentityVerification)
    private readonly verifications: Repository<IdentityVerification>,
    @InjectRepository(Account)
    private readonly accounts: Repository<Account>,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.logger.warn('Conexión con RabbitMQ cerrada.');
        this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      this.connection = connection;
      this.channel = channel;

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>(
        'RABBITMQ_QUEUE',
        'account-service.identity-verified',
      );

      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, exchange, 'identity.verified');
      await assertRetryQueues(channel, queue);

      await channel.consume(queue, (msg) => this.handleMessage(channel, queue, msg), {
        noAck: false,
      });

      this.logger.log(`Escuchando 'identity.verified' en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // Se usa el canal por el que llegó el mensaje: el ack debe ir por ese mismo canal.
  private async handleMessage(channel: amqplib.Channel, queue: string, msg: amqplib.ConsumeMessage | null) {
    if (!msg) return;
    try {
      let content: any;
      try {
        content = JSON.parse(msg.content.toString());
      } catch {
        throw new PoisonMessageError('El mensaje no es JSON válido.');
      }
      const idUser: string | undefined = content?.data?.idUser;

      if (!idUser) {
        this.logger.warn('Evento identity.verified sin idUser, descartado.');
        channel.ack(msg);
        return;
      }

      await this.verifications.upsert(
        { idUser, verified: true },
        ['idUser'],
      );

      // Si ya existía una cuenta pendiente para ese usuario, se activa.
      await this.accounts.update(
        { idUser, status: 'pending' },
        { status: 'active' },
      );

      this.logger.log(`identity.verified procesado para idUser=${idUser}`);
      channel.ack(msg);
    } catch (err) {
      handleFailure(channel, queue, msg, err as Error, this.logger);
    }
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
