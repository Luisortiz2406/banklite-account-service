import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as amqplib from 'amqplib';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { IdentityVerification } from '../accounts/entities/identity-verification.entity';

/**
 * Se suscribe al evento 'identity.verified' publicado por el Identity Service
 * (3.3 Microservicio de Cuentas — "Eventos que consume: identity.verified").
 *
 * Si RabbitMQ no está disponible al iniciar, reintenta en segundo plano
 * sin bloquear el arranque del servicio ni sus endpoints REST.
 */
@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventConsumer[account-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;

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
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      this.connection = await amqplib.connect(url);
      this.channel = await this.connection.createChannel();

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = this.config.get<string>(
        'RABBITMQ_QUEUE',
        'account-service.identity-verified',
      );

      await this.channel.assertExchange(exchange, 'topic', { durable: true });
      await this.channel.assertQueue(queue, { durable: true });
      await this.channel.bindQueue(queue, exchange, 'identity.verified');

      await this.channel.consume(queue, (msg) => this.handleMessage(msg), {
        noAck: false,
      });

      this.logger.log(`Escuchando 'identity.verified' en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en 5s.`,
      );
      setTimeout(() => this.connect(), 5000);
    }
  }

  private async handleMessage(msg: amqplib.ConsumeMessage | null) {
    if (!msg || !this.channel) return;
    try {
      const content = JSON.parse(msg.content.toString());
      const idUser: string | undefined = content?.data?.idUser;

      if (!idUser) {
        this.logger.warn('Evento identity.verified sin idUser, descartado.');
        this.channel.ack(msg);
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
      this.channel.ack(msg);
    } catch (err) {
      this.logger.error(`Error procesando evento: ${(err as Error).message}`);
      // No reencolar en bucle infinito ante payload corrupto.
      this.channel.nack(msg, false, false);
    }
  }

  async onModuleDestroy() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
