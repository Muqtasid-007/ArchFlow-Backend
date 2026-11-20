import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../src/app.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { disconnectRedis } from '../src/config/redis.js';
import { clearAnalysisCache } from '../src/services/aiService.js';

/**
 * Only allow an explicitly configured test database when it is local and its
 * database name clearly marks it as disposable. This runs before any drop.
 */
export function assertSafeTestMongoUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGO_TEST_URI must be a valid MongoDB URI for a local database ending in _test.');
  }

  const host = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1'].includes(host)
      || !databaseName.endsWith('_test')) {
    throw new Error(
      'Unsafe MONGO_TEST_URI: use localhost or 127.0.0.1 and a database name ending in _test.',
    );
  }
  return uri;
}

let memoryServer;

async function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function setupDatabase() {
  let uri = process.env.MONGO_TEST_URI;
  // Validate before connecting or dropping any database.
  if (uri) assertSafeTestMongoUri(uri);
  if (!uri) {
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: 'archflow_test' },
    });
    uri = memoryServer.getUri();
    console.log('[test] MongoDB memory server started:', uri);
  } else {
    console.log('[test] Using validated local test MongoDB override');
  }

  await connectDatabase(uri);
  await mongoose.connection.dropDatabase();
  console.log('[test] MongoDB test database ready');
}

export async function teardownDatabase() {
  clearAnalysisCache();
  let cleanupError;
  try {
    // Test files must not leave open database clients for the next file.
    await withTimeout(disconnectRedis(), 'Redis disconnect');
  } catch (error) {
    cleanupError = error;
  }

  try {
    // The next setup starts from a clean database. Disconnect even if cleanup fails.
    if (mongoose.connection.readyState !== 0) {
      await withTimeout(mongoose.connection.dropDatabase(), 'MongoDB test database cleanup');
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    try {
      await withTimeout(disconnectDatabase(), 'MongoDB disconnect');
    } catch (error) {
      cleanupError ??= error;
    }
    if (memoryServer) {
      const serverToStop = memoryServer;
      memoryServer = undefined;
      try {
        await withTimeout(serverToStop.stop(), 'MongoDB memory server stop');
        console.log('[test] MongoDB memory server stopped');
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (cleanupError) throw cleanupError;
}

export async function registerUser(options = {}) {
  const email = options.email ?? `user-${crypto.randomUUID().slice(0, 8)}@archflow.test`;
  const password = options.password ?? 'Password123';
  const response = await request(app)
    .post('/api/auth/register')
    .send({ name: options.name ?? 'Test User', email, password });

  if (response.status !== 201) {
    throw new Error(`Registration failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { token: response.body.accessToken, user: response.body.user, email, password };
}

export function authed(req, token) {
  return req.set('Authorization', `Bearer ${token}`);
}

export async function createBoard(token, overrides = {}) {
  const response = await authed(request(app).post('/api/boards'), token).send({
    name: overrides.name ?? `Board ${crypto.randomUUID().slice(0, 6)}`,
    description: overrides.description ?? 'Test board',
  });
  if (response.status !== 201) {
    throw new Error(`Board creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.board;
}

export async function inviteMember(token, boardId, email, role) {
  return authed(request(app).post(`/api/boards/${boardId}/members`), token).send({ email, role });
}

export const cookieValue = (setCookieHeaders, name) => {
  const header = (setCookieHeaders ?? []).find((value) => value.startsWith(`${name}=`));
  return header ? header.split(';')[0] : null;
};

export const sampleGraph = {
  nodes: [
    {
      id: 'client',
      type: 'client',
      label: 'Web Client',
      x: 0,
      y: 0,
      width: 208,
      height: 96,
      description: '',
      entities: [],
    },
    {
      id: 'db',
      type: 'database',
      label: 'MongoDB',
      x: 400,
      y: 0,
      width: 208,
      height: 96,
      description: '',
      entities: ['Users', 'Orders'],
    },
  ],
  edges: [{ id: 'e1', from: 'client', to: 'db', label: 'direct', kind: 'sync', description: '' }],
};
