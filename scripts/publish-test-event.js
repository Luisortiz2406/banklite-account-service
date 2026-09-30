/**
 * Simula al Identity Service publicando el evento identity.verified.
 * Útil para probar Account Service sin tener el Identity Service real.
 *
 * Uso:
 *   node scripts/publish-test-event.js <idUser-uuid>
 */
require('dotenv').config();
const amqplib = require('amqplib');

async function main() {
  const idUser = process.argv[2];
  if (!idUser) {
    console.error('Uso: node scripts/publish-test-event.js <idUser-uuid>');
    process.exit(1);
  }

  const url = process.env.RABBITMQ_URL || 'amqp://banklite:banklite@localhost:5672';
  const exchange = process.env.RABBITMQ_EXCHANGE || 'banklite.events';

  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();
  await channel.assertExchange(exchange, 'topic', { durable: true });

  const message = {
    event: 'identity.verified',
    occurredAt: new Date().toISOString(),
    data: { idUser },
  };

  channel.publish(exchange, 'identity.verified', Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: 'application/json',
  });

  console.log(`Evento identity.verified publicado para idUser=${idUser}`);
  await channel.close();
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
