import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { io as createClient } from 'socket.io-client';
import { app } from '../src/app.js';
import { disconnectRedis, resetTestRedisDatabase } from '../src/config/redis.js';
import { createRealtimeServer } from '../src/sockets/index.js';
import { createBoard, inviteMember, registerUser, setupDatabase, teardownDatabase } from './helpers.js';

const servers = [];
const sockets = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function join(socket, boardId) {
  return new Promise((resolve) => socket.emit('board:join', { boardId }, resolve));
}

function emitOp(socket, boardId, op) {
  return new Promise((resolve) =>
    socket.emit(
      'canvas:op',
      {
        boardId,
        opId: `multi-${crypto.randomUUID()}`,
        baseRevision: 1,
        op,
      },
      resolve,
    ),
  );
}

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for socket event: ${event}`));
    }, 5000);
    const onEvent = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, onEvent);
  });
}

before(async () => {
  await setupDatabase();

  for (const port of [0, 0]) {
    const httpServer = http.createServer(app);
    const ioServer = await createRealtimeServer(httpServer);
    await listen(httpServer);
    servers.push({ httpServer, ioServer, port: httpServer.address().port });
  }
  await resetTestRedisDatabase();
});

after(async () => {
  const errors = [];
  const clean = async (label, action) => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
  };

  // Disconnect clients before closing servers so no socket keeps a test file alive.
  for (const socket of sockets) socket.disconnect();
  for (const { ioServer, httpServer } of servers) {
    await clean('Socket.IO close', () => new Promise((resolve) => ioServer.close(resolve)));
    if (ioServer.data.redisAdapterClose) {
      await clean('Redis adapter close', () => ioServer.data.redisAdapterClose());
    }
    if (httpServer.listening) {
      await clean('HTTP server close', () => new Promise((resolve) => httpServer.close(resolve)));
    }
  }
  await clean('Redis disconnect', () => disconnectRedis());
  await clean('MongoDB teardown', () => teardownDatabase());
  if (errors.length) throw new AggregateError(errors, 'One or more multi-instance test resources failed to close');
});

test('broadcasts an edit from instance 1 to a user on instance 2', async () => {
  const owner = await registerUser({ name: 'Instance One User' });
  const member = await registerUser({ name: 'Instance Two User' });
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, member.email, 'editor');

  console.log('1. Connecting users to different API instances');
  const ownerSocket = await connect(servers[0].port, owner.token);
  const memberSocket = await connect(servers[1].port, member.token);
  sockets.push(ownerSocket, memberSocket);

  assert.equal((await join(ownerSocket, board.id)).ok, true);
  assert.equal((await join(memberSocket, board.id)).ok, true);

  console.log('2. Waiting for instance 2 to receive instance 1 operation');
  const received = waitFor(memberSocket, 'canvas:op');
  const result = await emitOp(ownerSocket, board.id, {
    type: 'node.create',
    node: {
      id: 'redis-node',
      type: 'service',
      label: 'Redis Broadcast',
      x: 10,
      y: 20,
      width: 208,
      height: 96,
      description: '',
      entities: [],
    },
  });

  console.log('3. Instance 1 acknowledgement:', result);
  assert.equal(result.ok, true);

  const event = await received;
  console.log('4. Instance 2 received:', event.op.type, event.op.node.label);
  assert.equal(event.op.node.label, 'Redis Broadcast');
  assert.equal(event.revision, 2);
});
