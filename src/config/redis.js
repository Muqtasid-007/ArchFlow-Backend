import { createClient } from 'redis';
import { env } from './env.js';
import { logger } from './logger.js';

let client;
let pubClient;
let subClient;

function createConfiguredClient() {
  return createClient({
    url: env.REDIS_URL,
    // A missing test Redis should fail quickly instead of retrying forever.
    ...(env.isTest
      ? { socket: { connectTimeout: 5000, reconnectStrategy: (retries) => (retries < 2 ? 250 : false) } }
      : {}),
  });
}

export async function connectRedis() {
  if (client?.isReady && pubClient?.isReady && subClient?.isReady) {
    return { client, pubClient, subClient };
  }

  client = createConfiguredClient();
  pubClient = client.duplicate();
  subClient = client.duplicate();

  for (const connection of [client, pubClient, subClient]) {
    connection.on('error', (error) => logger.error({ err: error }, 'Redis connection error'));
  }

  await Promise.all([client.connect(), pubClient.connect(), subClient.connect()]);
  logger.info({ url: env.REDIS_URL }, 'Redis connected');
  return { client, pubClient, subClient };
}

export function getRedisClient() {
  if (!client?.isReady) throw new Error('Redis is not connected');
  return client;
}

// Test cleanup is deliberately scoped to the isolated Redis database selected
// by TEST_REDIS_URL. It cannot run against development or production config.
export async function resetTestRedisDatabase() {
  if (!env.isTest) throw new Error('Redis test database cleanup is only available in test mode.');
  if (!client?.isReady) throw new Error('Redis must be connected before test cleanup.');
  await client.flushDb();
}

export async function createRedisAdapterClients() {
  const pubClient = createConfiguredClient();
  const subClient = pubClient.duplicate();

  for (const connection of [pubClient, subClient]) {
    connection.on('error', (error) => logger.error({ err: error }, 'Redis adapter connection error'));
  }

  await Promise.all([pubClient.connect(), subClient.connect()]);
  return {
    pubClient,
    subClient,
    close: async () => {
      await Promise.allSettled(
        [pubClient, subClient].map(async (connection) => {
          if (!connection.isOpen) return;
          await connection.disconnect();
        }),
      );
    },
  };
}

export async function disconnectRedis() {
  await Promise.allSettled(
    [client, pubClient, subClient].map(async (connection) => {
      if (!connection?.isOpen) return;
      await connection.disconnect();
    }),
  );
  client = undefined;
  pubClient = undefined;
  subClient = undefined;
}
