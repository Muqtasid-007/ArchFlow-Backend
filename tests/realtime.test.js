import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { io as createClient } from 'socket.io-client';
import * as Y from 'yjs';
import { app } from '../src/app.js';
import { Board } from '../src/models/Board.js';
import { Snapshot } from '../src/models/Snapshot.js';
import { restoreSnapshot } from '../src/services/snapshotService.js';
import { createRealtimeServer } from '../src/sockets/index.js';
import { getBoardState, getBoardStateFromRedis } from '../src/services/boardState.js';
import { clearStickyDocsForBoard, getStickyDoc } from '../src/services/stickyNoteService.js';
import { disconnectRedis, getRedisClient, resetTestRedisDatabase } from '../src/config/redis.js';
import { disconnectBoardEvents } from '../src/services/boardEvents.js';
import { flushStickyDocs } from '../src/services/stickyNoteService.js';
import { flushAllBoards } from '../src/services/boardState.js';
import { authed, createBoard, inviteMember, registerUser, setupDatabase, teardownDatabase } from './helpers.js';

let httpServer;
let ioServer;
let port;

before(async () => {
  process.env.DISABLE_SOCKET_REDIS_ADAPTER = 'true';
  await setupDatabase();
  httpServer = http.createServer(app);
  ioServer = await createRealtimeServer(httpServer);
  await resetTestRedisDatabase();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = httpServer.address().port;
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

  // Close the socket server first, then flush and close every shared client.
  if (ioServer) await clean('Socket.IO close', () => new Promise((resolve) => ioServer.close(resolve)));
  if (ioServer?.data.redisAdapterClose) await clean('Redis adapter close', () => ioServer.data.redisAdapterClose());
  if (httpServer?.listening) await clean('HTTP server close', () => new Promise((resolve) => httpServer.close(resolve)));
  await clean('Pending board flush', () => flushAllBoards());
  await clean('Sticky document flush', () => flushStickyDocs());
  await clean('Board event disconnect', () => disconnectBoardEvents());
  await clean('Redis disconnect', () => disconnectRedis());
  await clean('MongoDB teardown', () => teardownDatabase());

  if (errors.length) throw new AggregateError(errors, 'One or more realtime test resources failed to close');
});

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
  });
}

function join(socket, boardId) {
  return new Promise((resolve) => socket.emit('board:join', { boardId }, resolve));
}

function emitOp(socket, boardId, op, options = {}) {
  return new Promise((resolve) =>
    socket.emit(
      'canvas:op',
      {
        boardId,
        opId: options.opId ?? `test-${crypto.randomUUID()}`,
        baseRevision: options.baseRevision ?? 1,
        op,
      },
      resolve,
    ),
  );
}

function emitCursor(socket, boardId, x, y) {
  socket.emit('cursor:move', { boardId, x, y });
}

function changeMemberRole(ownerToken, boardId, memberId, role) {
  return authed(
    request(app).patch(`/api/boards/${boardId}/members/${memberId}`),
    ownerToken,
  ).send({ role });
}

function removeMember(ownerToken, boardId, memberId) {
  return authed(
    request(app).delete(`/api/boards/${boardId}/members/${memberId}`),
    ownerToken,
  );
}

const waitFor = (socket, event, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for socket event: ${event}`));
    }, timeoutMs);
    const onEvent = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, onEvent);
  });

async function waitForCondition(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function makeBoardAndStickyDocDirty(socket, boardId) {
  const nodeId = `sticky-${crypto.randomUUID().slice(0, 8)}`;
  const create = await emitOp(socket, boardId, {
    type: 'node.create',
    node: {
      id: nodeId,
      type: 'sticky',
      label: 'Flush me',
      x: 0,
      y: 0,
      width: 220,
      height: 140,
      description: '',
      entities: [],
    },
  });
  assert.equal(create.ok, true);

  const joined = await new Promise((resolve) => {
    socket.emit('sticky:join', { boardId, nodeId }, resolve);
  });
  assert.equal(joined.ok, true);

  const localDoc = new Y.Doc();
  localDoc.getText('text').insert(0, 'Saved when the room empties');
  const update = await new Promise((resolve) => {
    socket.emit('sticky:update', { boardId, nodeId, update: Y.encodeStateAsUpdate(localDoc) }, resolve);
  });
  assert.equal(update.ok, true);
  return nodeId;
}

test('rejects unauthenticated socket connections', async () => {
  await assert.rejects(connect('not-a-real-token'), /unauthorized/);
});

test('syncs canvas operations between members and blocks viewers', async () => {
  const owner = await registerUser();
  const viewer = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, viewer.email, 'viewer');

  const ownerSocket = await connect(owner.token);
  const viewerSocket = await connect(viewer.token);

  try {
    const ownerJoin = await join(ownerSocket, board.id);
    assert.equal(ownerJoin.ok, true);
    assert.equal(ownerJoin.role, 'admin');

    const viewerJoin = await join(viewerSocket, board.id);
    assert.equal(viewerJoin.ok, true);
    assert.equal(viewerJoin.role, 'viewer');

    const node = {
      id: 'svc-1',
      type: 'service',
      label: 'Orders Service',
      x: 40,
      y: 80,
      width: 208,
      height: 96,
      description: '',
      entities: ['Orders'],
    };

    const received = waitFor(viewerSocket, 'canvas:op');
    const ownerResult = await emitOp(ownerSocket, board.id, { type: 'node.create', node });
    assert.equal(ownerResult.ok, true);
    assert.equal(ownerResult.revision, 2);

    const broadcast = await received;
    assert.equal(broadcast.op.type, 'node.create');
    assert.equal(broadcast.op.node.label, 'Orders Service');
    assert.equal(broadcast.actor.id, owner.user.id);

    const viewerAttempt = await emitOp(viewerSocket, board.id, {
      type: 'node.update',
      nodeId: 'svc-1',
      patch: { label: 'Hijacked' },
    });
    assert.equal(viewerAttempt.ok, false);
    assert.match(viewerAttempt.error, /read-only/i);

    const outsider = await registerUser();
    const outsiderSocket = await connect(outsider.token);
    try {
      const outsiderJoin = await join(outsiderSocket, board.id);
      assert.equal(outsiderJoin.ok, false);
      assert.match(outsiderJoin.error, /not a member/i);
    } finally {
      outsiderSocket.close();
    }
  } finally {
    ownerSocket.close();
    viewerSocket.close();
  }
});

test('broadcasts cursor position and removes it on disconnect', async () => {
  const owner = await registerUser();
  const member = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, member.email, 'editor');

  const ownerSocket = await connect(owner.token);
  const memberSocket = await connect(member.token);

  try {
    await join(ownerSocket, board.id);
    await join(memberSocket, board.id);

    const receivedCursor = waitFor(memberSocket, 'cursor:move');
    emitCursor(ownerSocket, board.id, 240, 360);

    const cursor = await receivedCursor;
    assert.equal(cursor.boardId, board.id);
    assert.equal(cursor.x, 240);
    assert.equal(cursor.y, 360);
    assert.equal(cursor.user.id, owner.user.id);

    const receivedLeave = waitFor(memberSocket, 'cursor:leave');
    ownerSocket.close();
    const leave = await receivedLeave;
    assert.equal(leave.boardId, board.id);
    assert.equal(leave.userId, owner.user.id);
  } finally {
    ownerSocket.close();
    memberSocket.close();
  }
});

test('flushes board and sticky changes when the last socket leaves', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const nodeId = await makeBoardAndStickyDocDirty(socket, board.id);

    socket.emit('board:leave', { boardId: board.id });
    const saved = await waitForCondition(async () => {
      const current = await Board.findById(board.id).select('graph').lean();
      const sticky = current?.graph?.nodes?.find((node) => node.id === nodeId);
      return Boolean(sticky?.stickyUpdate?.length);
    });

    assert.equal(saved, true, 'both the new board node and sticky binary should reach Mongo promptly');
    const current = await Board.findById(board.id).select('graph').lean();
    assert.ok(current.graph.nodes.some((node) => node.id === nodeId));
    console.log('[persistence test] Last board:leave flushed graph and sticky binary');
  } finally {
    socket.close();
  }
});

test('sets and refreshes the seven-day Redis board-state TTL', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const node = {
      id: 'ttl-check',
      type: 'service',
      label: 'TTL check',
      x: 0,
      y: 0,
      width: 208,
      height: 96,
      description: '',
      entities: [],
    };
    assert.equal((await emitOp(socket, board.id, { type: 'node.create', node })).ok, true);

    const key = `archflow:board:${board.id}`;
    assert.ok((await getRedisClient().ttl(key)) > 604_700);

    // Give the key a short expiry, then prove a read restores seven days.
    await getRedisClient().expire(key, 5);
    await getBoardStateFromRedis(board.id);
    assert.ok((await getRedisClient().ttl(key)) > 604_700);
    console.log('[persistence test] Board Redis key received and refreshed a seven-day TTL');
  } finally {
    socket.close();
  }
});

test('reloads board state when Mongo has a newer revision than Redis', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const key = `archflow:board:${board.id}`;
  const staleGraph = { nodes: [], edges: [] };
  const freshGraph = {
    nodes: [{
      id: 'mongo-newer',
      type: 'service',
      label: 'Mongo revision wins',
      x: 10,
      y: 20,
      width: 208,
      height: 96,
      description: '',
      entities: [],
      stickyUpdate: null,
    }],
    edges: [],
  };

  await getRedisClient().set(key, JSON.stringify({
    graph: staleGraph,
    revision: 2,
    lastEditor: null,
    appliedOps: {},
  }));
  await Board.updateOne({ _id: board.id }, { $set: { graph: freshGraph, revision: 3 } });

  const loaded = await getBoardState(board.id);
  assert.equal(loaded.revision, 3);
  assert.deepEqual(loaded.graph, freshGraph);

  const refreshedRedis = await getBoardStateFromRedis(board.id);
  assert.equal(refreshedRedis.revision, 3);
  assert.deepEqual(refreshedRedis.graph, freshGraph);
  console.log('[persistence test] Mongo revision 3 replaced stale Redis revision 2');
});

test('flushes pending board changes when the last socket disconnects', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);
  await join(socket, board.id);
  await makeBoardAndStickyDocDirty(socket, board.id);

  const disconnected = waitFor(socket, 'disconnect');
  socket.close();
  await disconnected;

  const saved = await waitForCondition(async () => {
    const current = await Board.findById(board.id).select('graph').lean();
    return current?.graph?.nodes?.some((node) => node.label === 'Flush me') ?? false;
  });
  assert.equal(saved, true, 'the last socket disconnect should flush its pending canvas operation');
  console.log('[persistence test] Last socket disconnect flushed board changes');
});

test('node.delete removes its cached sticky document', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const nodeId = await makeBoardAndStickyDocDirty(socket, board.id);
    const deleted = await emitOp(
      socket,
      board.id,
      { type: 'node.delete', nodeId },
      { baseRevision: 2 },
    );
    assert.equal(deleted.ok, true);

    const state = await getBoardStateFromRedis(board.id);
    assert.equal(state.graph.nodes.some((node) => node.id === nodeId), false);
    // If the old Y.Doc were still cached, this call would return it immediately.
    await assert.rejects(getStickyDoc(board.id, nodeId));
    console.log('[sticky test] node.delete cleared its cached Y.Doc');
  } finally {
    socket.close();
  }
});

test('restore cache cleanup forgets a dirty sticky Y.Doc and cancels its save timer', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const nodeId = await makeBoardAndStickyDocDirty(socket, board.id);
    const cachedDoc = await getStickyDoc(board.id, nodeId);

    clearStickyDocsForBoard(board.id);
    const reloadedDoc = await getStickyDoc(board.id, nodeId);

    assert.notEqual(reloadedDoc, cachedDoc, 'the next read should construct a fresh Y.Doc');
    await flushStickyDocs(board.id);
    console.log('[sticky test] Restore cleared cached Y.Docs and canceled pending sticky saves');
  } finally {
    socket.close();
  }
});

test('a sticky note being edited resyncs from the restored snapshot', async () => {
  const owner = await registerUser();
  const editor = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, editor.email, 'editor');
  const ownerSocket = await connect(owner.token);
  const editorSocket = await connect(editor.token);
  const nodeId = 'restore-while-typing';

  try {
    await join(ownerSocket, board.id);
    await join(editorSocket, board.id);
    const create = await emitOp(ownerSocket, board.id, {
      type: 'node.create',
      node: {
        id: nodeId, type: 'sticky', label: 'Shared note', x: 0, y: 0,
        width: 220, height: 140, description: '', entities: [],
      },
    });
    assert.equal(create.ok, true);

    const initialDoc = new Y.Doc();
    initialDoc.getText('text').insert(0, 'Saved version');
    const initialAck = await new Promise((resolve) => ownerSocket.emit(
      'sticky:update',
      { boardId: board.id, nodeId, update: Y.encodeStateAsUpdate(initialDoc) },
      resolve,
    ));
    assert.equal(initialAck.ok, true);
    await flushStickyDocs(board.id);
    await flushAllBoards();

    const savedBoard = await Board.findById(board.id).lean();
    savedBoard.graph.nodes[0].stickyUpdate = Buffer.from(
      Y.encodeStateAsUpdate(await getStickyDoc(board.id, nodeId)),
    );
    const savedTextDoc = new Y.Doc();
    Y.applyUpdate(savedTextDoc, savedBoard.graph.nodes[0].stickyUpdate);
    assert.equal(savedTextDoc.getText('text').toString(), 'Saved version');
    const snapshot = await Snapshot.create({
      board: board.id,
      name: 'Saved sticky text',
      kind: 'manual',
      graph: savedBoard.graph,
      revision: savedBoard.revision,
      createdBy: owner.user.id,
    });

    const joined = await new Promise((resolve) => editorSocket.emit(
      'sticky:join', { boardId: board.id, nodeId }, resolve,
    ));
    const typingDoc = new Y.Doc();
    Y.applyUpdate(typingDoc, joined.update);
    typingDoc.getText('text').insert(typingDoc.getText('text').length, ' typed during restore');

    const resyncReceived = waitFor(editorSocket, 'sticky:resync');
    const restoreRequest = restoreSnapshot(board.id, snapshot.id, owner.user.id);
    const typingAck = await new Promise((resolve) => editorSocket.emit(
      'sticky:update',
      { boardId: board.id, nodeId, update: Y.encodeStateAsUpdate(typingDoc) },
      resolve,
    ));
    const restoreResponse = await restoreRequest;
    assert.equal(typingAck.ok, true);
    assert.equal(restoreResponse.sourceSnapshot, 'Saved sticky text');
    const resync = await resyncReceived;
    assert.equal(resync.boardId, board.id);

    // A mounted note handles this notification by replacing its local Y.Doc and joining again.
    const rejoined = await new Promise((resolve) => editorSocket.emit(
      'sticky:join', { boardId: board.id, nodeId }, resolve,
    ));
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, rejoined.update);
    assert.equal(restoredDoc.getText('text').toString(), 'Saved version');
    console.log('[sticky test] Restore notified the typing client; rejoin loaded restored text');
  } finally {
    ownerSocket.close();
    editorSocket.close();
  }
});

test('rejects sticky updates after role change or removal', async () => {
  const owner = await registerUser();
  const changedMember = await registerUser();
  const removedMember = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, changedMember.email, 'editor');
  await inviteMember(owner.token, board.id, removedMember.email, 'editor');

  const ownerSocket = await connect(owner.token);
  const changedSocket = await connect(changedMember.token);
  const removedSocket = await connect(removedMember.token);

  try {
    await join(ownerSocket, board.id);
    await join(changedSocket, board.id);
    await join(removedSocket, board.id);

    const nodeId = 'sticky-role-test';
    await emitOp(ownerSocket, board.id, {
      type: 'node.create',
      node: {
        id: nodeId,
        type: 'sticky',
        label: 'Role test',
        x: 40,
        y: 80,
        width: 220,
        height: 180,
        description: '',
        entities: [],
      },
    });

    async function joinSticky(socket) {
      return new Promise((resolve) => {
        socket.emit('sticky:join', { boardId: board.id, nodeId }, resolve);
      });
    }

    const changedJoin = await joinSticky(changedSocket);
    const removedJoin = await joinSticky(removedSocket);
    assert.equal(changedJoin.ok, true);
    assert.equal(removedJoin.ok, true);

    function makeDelta(joinResponse) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Uint8Array.from(joinResponse.update), 'join');
      let delta;
      doc.on('update', (update, origin) => {
        if (origin !== 'join') delta = update;
      });
      doc.getText('text').insert(doc.getText('text').length, 'new text');
      return delta;
    }

    const changedDelta = makeDelta(changedJoin);
    const changedResponse = await changeMemberRole(
      owner.token,
      board.id,
      changedMember.user.id,
      'viewer',
    );
    assert.equal(changedResponse.status, 200);
    console.log('[sticky test] Changed editor to viewer');

    const changedAck = await new Promise((resolve) => {
      changedSocket.emit(
        'sticky:update',
        { boardId: board.id, nodeId, update: changedDelta },
        resolve,
      );
    });
    assert.equal(changedAck.ok, false);
    assert.match(changedAck.error, /viewer/i);
    console.log('[sticky test] Role-changed socket rejected:', changedAck);

    const removedDelta = makeDelta(removedJoin);
    const removedResponse = await removeMember(
      owner.token,
      board.id,
      removedMember.user.id,
    );
    assert.equal(removedResponse.status, 204);
    console.log('[sticky test] Removed editor from board');

    const removedAck = await new Promise((resolve) => {
      removedSocket.emit(
        'sticky:update',
        { boardId: board.id, nodeId, update: removedDelta },
        resolve,
      );
    });
    assert.equal(removedAck.ok, false);
    assert.match(removedAck.error, /no longer/i);
    console.log('[sticky test] Removed socket rejected:', removedAck);
  } finally {
    ownerSocket.close();
    changedSocket.close();
    removedSocket.close();
  }
});

test('merges sticky-note text and rejects viewer updates', async () => {
  const owner = await registerUser();
  const editor = await registerUser();
  const viewer = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, editor.email, 'editor');
  await inviteMember(owner.token, board.id, viewer.email, 'viewer');

  const ownerSocket = await connect(owner.token);
  const editorSocket = await connect(editor.token);
  const viewerSocket = await connect(viewer.token);

  try {
    await join(ownerSocket, board.id);
    await join(editorSocket, board.id);
    await join(viewerSocket, board.id);

    const nodeId = 'sticky-1';
    const create = await emitOp(ownerSocket, board.id, {
      type: 'node.create',
      node: {
        id: nodeId,
        type: 'sticky',
        label: 'Shared note',
        x: 40,
        y: 80,
        width: 220,
        height: 180,
        description: '',
        entities: [],
      },
    });
    assert.equal(create.ok, true);

    function joinSticky(socket) {
      return new Promise((resolve) => {
        socket.emit('sticky:join', { boardId: board.id, nodeId }, resolve);
      });
    }

    const ownerJoin = await joinSticky(ownerSocket);
    const editorJoin = await joinSticky(editorSocket);
    const viewerJoin = await joinSticky(viewerSocket);
    assert.equal(ownerJoin.ok, true);
    assert.equal(editorJoin.ok, true);
    assert.equal(viewerJoin.ok, true);

    const ownerDoc = new Y.Doc();
    const editorDoc = new Y.Doc();
    Y.applyUpdate(ownerDoc, Uint8Array.from(ownerJoin.update), 'join');
    Y.applyUpdate(editorDoc, Uint8Array.from(editorJoin.update), 'join');

    console.log('[sticky test] Step 1: both tabs joined', nodeId);

    let ownerDelta;
    let editorDelta;
    ownerDoc.on('update', (update, origin) => {
      if (origin !== 'join') ownerDelta = update;
    });
    editorDoc.on('update', (update, origin) => {
      if (origin !== 'join') editorDelta = update;
    });

    ownerDoc.getText('text').insert(ownerDoc.getText('text').length, 'A');
    editorDoc.getText('text').insert(editorDoc.getText('text').length, 'B');
    assert.ok(ownerDelta);
    assert.ok(editorDelta);

    console.log('[sticky test] Step 2: tabs typed A and B');

    const receivedOwnerUpdate = waitFor(ownerSocket, 'sticky:update');
    const receivedEditorUpdate = waitFor(editorSocket, 'sticky:update');

    const ownerAck = await new Promise((resolve) => {
      ownerSocket.emit(
        'sticky:update',
        { boardId: board.id, nodeId, update: ownerDelta },
        resolve,
      );
    });
    const editorAck = await new Promise((resolve) => {
      editorSocket.emit(
        'sticky:update',
        { boardId: board.id, nodeId, update: editorDelta },
        resolve,
      );
    });
    assert.equal(ownerAck.ok, true);
    assert.equal(editorAck.ok, true);

    const editorReceivedOwner = await receivedEditorUpdate;
    Y.applyUpdate(editorDoc, Uint8Array.from(editorReceivedOwner.update), 'remote');

    const ownerReceivedEditor = await receivedOwnerUpdate;
    Y.applyUpdate(ownerDoc, Uint8Array.from(ownerReceivedEditor.update), 'remote');

    console.log('[sticky test] Step 3: server merged binary updates');
    console.log('[sticky test] Owner text:', ownerDoc.getText('text').toString());
    console.log('[sticky test] Editor text:', editorDoc.getText('text').toString());

    assert.equal(ownerDoc.getText('text').toString(), editorDoc.getText('text').toString());
    assert.match(ownerDoc.getText('text').toString(), /A/);
    assert.match(ownerDoc.getText('text').toString(), /B/);

    const viewerDoc = new Y.Doc();
    Y.applyUpdate(viewerDoc, Uint8Array.from(viewerJoin.update), 'join');
    let viewerDelta;
    const capture = (update, origin) => {
      if (origin !== 'join') viewerDelta = update;
    };
    viewerDoc.on('update', capture);
    viewerDoc.getText('text').insert(viewerDoc.getText('text').length, 'X');
    const viewerAck = await new Promise((resolve) => {
      viewerSocket.emit(
        'sticky:update',
        { boardId: board.id, nodeId, update: viewerDelta },
        resolve,
      );
    });
    console.log('[sticky test] Step 4: viewer rejected:', viewerAck);
    assert.equal(viewerAck.ok, false);
  } finally {
    ownerSocket.close();
    editorSocket.close();
    viewerSocket.close();
  }
});

test('replays duplicate operation ids and rejects stale revisions', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const node = {
      id: 'svc-1',
      type: 'service',
      label: 'Orders Service',
      x: 40,
      y: 80,
      width: 208,
      height: 96,
      description: '',
      entities: [],
    };

    const first = await emitOp(socket, board.id, { type: 'node.create', node }, { opId: 'op-1' });
    assert.deepEqual(first, { ok: true, opId: 'op-1', revision: 2 });

    const duplicate = await emitOp(socket, board.id, { type: 'node.create', node }, { opId: 'op-1' });
    assert.deepEqual(duplicate, first);

    const stale = await emitOp(
      socket,
      board.id,
      { type: 'node.update', nodeId: 'svc-1', patch: { label: 'Stale update' } },
      { opId: 'op-2', baseRevision: 1 },
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.opId, 'op-2');
    assert.equal(stale.revision, 2);
    assert.match(stale.error, /revision/i);
  } finally {
    socket.close();
  }
});

test('rejects structurally invalid canvas operations', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const socket = await connect(owner.token);

  try {
    await join(socket, board.id);
    const result = await emitOp(socket, board.id, {
      type: 'node.create',
      node: { id: 'bad id!', type: 'service', label: '', x: 0, y: 0 },
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.length > 0);
  } finally {
    socket.close();
  }
});

test('comments use separate socket events, broadcast saved changes, and recheck current membership', async () => {
  const owner = await registerUser();
  const viewer = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, viewer.email, 'viewer');
  const ownerSocket = await connect(owner.token);
  const viewerSocket = await connect(viewer.token);

  const emitComment = (socket, event, payload) => new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });

  try {
    await join(ownerSocket, board.id);
    await join(viewerSocket, board.id);

    const createdOnViewer = waitFor(viewerSocket, 'comment:created');
    const created = await emitComment(ownerSocket, 'comment:create', {
      boardId: board.id,
      anchor: { type: 'canvas', x: 30, y: 40 },
      text: 'Socket thread',
    });
    assert.equal(created.ok, true);
    assert.equal((await createdOnViewer).thread.id, created.thread.id);

    const repliedOnOwner = waitFor(ownerSocket, 'comment:replied');
    const reply = await emitComment(viewerSocket, 'comment:reply', {
      boardId: board.id,
      threadId: created.thread.id,
      text: 'Viewer reply',
    });
    assert.equal(reply.ok, true);
    assert.equal((await repliedOnOwner).reply.id, reply.reply.id);

    const editedOnViewer = waitFor(viewerSocket, 'comment:edited');
    const edited = await emitComment(ownerSocket, 'comment:edit', {
      boardId: board.id,
      commentId: created.thread.id,
      text: 'Edited socket thread',
    });
    assert.equal(edited.ok, true);
    assert.equal((await editedOnViewer).comment.text, 'Edited socket thread');

    const resolvedOnViewer = waitFor(viewerSocket, 'comment:resolved');
    const resolved = await emitComment(ownerSocket, 'comment:resolve', {
      boardId: board.id,
      threadId: created.thread.id,
    });
    assert.equal(resolved.ok, true);
    assert.equal((await resolvedOnViewer).thread.resolved, true);

    const reopenedOnViewer = waitFor(viewerSocket, 'comment:reopened');
    const reopened = await emitComment(ownerSocket, 'comment:reopen', {
      boardId: board.id,
      threadId: created.thread.id,
    });
    assert.equal(reopened.ok, true);
    await reopenedOnViewer;

    const deletedOnOwner = waitFor(ownerSocket, 'comment:deleted');
    const deleted = await emitComment(viewerSocket, 'comment:delete', {
      boardId: board.id,
      commentId: reply.reply.id,
    });
    assert.equal(deleted.ok, true);
    assert.equal((await deletedOnOwner).commentId, reply.reply.id);

    const invalid = await emitComment(viewerSocket, 'comment:reply', {
      boardId: board.id,
      threadId: created.thread.id,
      text: '   ',
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /empty/i);

    // Simulate membership revocation without the normal disconnect broadcast.
    await Board.updateOne({ _id: board.id }, { $pull: { members: { user: viewer.user.id } } });
    const removedMemberWrite = await emitComment(viewerSocket, 'comment:create', {
      boardId: board.id,
      anchor: { type: 'canvas', x: 1, y: 2 },
      text: 'Should be rejected',
    });
    assert.equal(removedMemberWrite.ok, false);
    assert.match(removedMemberWrite.error, /not a member/i);
    console.log('[comments socket test] Write events broadcast saved threads; invalid and removed-member writes were rejected');
  } finally {
    ownerSocket.close();
    viewerSocket.close();
  }
});
