import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { Board } from '../src/models/Board.js';
import { Comment } from '../src/models/Comment.js';
import { createSnapshot, restoreSnapshot } from '../src/services/snapshotService.js';
import { invalidateBoard } from '../src/services/boardState.js';
import { connectRedis, resetTestRedisDatabase } from '../src/config/redis.js';
import {
  authed,
  createBoard,
  inviteMember,
  registerUser,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';

before(async () => {
  await setupDatabase();
  await connectRedis();
  await resetTestRedisDatabase();
});

after(async () => {
  // teardownDatabase closes Redis and MongoDB even if one cleanup step fails.
  await teardownDatabase();
});

async function createThread(token, boardId, anchor = { type: 'canvas', x: 10, y: 20 }, text = 'A comment') {
  return authed(request(app).post(`/api/boards/${boardId}/comments`), token).send({ anchor, text });
}

test('viewers can comment but cannot resolve another member’s thread', async () => {
  const owner = await registerUser();
  const editor = await registerUser();
  const viewer = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, editor.email, 'editor');
  await inviteMember(owner.token, board.id, viewer.email, 'viewer');

  const editorThread = await createThread(editor.token, board.id);
  assert.equal(editorThread.status, 201, JSON.stringify(editorThread.body));
  const viewerThread = await createThread(viewer.token, board.id);
  assert.equal(viewerThread.status, 201, JSON.stringify(viewerThread.body));

  const reply = await authed(
    request(app).post(`/api/boards/${board.id}/comments/${editorThread.body.thread.id}/replies`),
    viewer.token,
  ).send({ text: 'A viewer reply' });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));

  const resolve = await authed(
    request(app).patch(`/api/boards/${board.id}/comments/${editorThread.body.thread.id}/resolve`),
    viewer.token,
  ).send({});
  assert.equal(resolve.status, 403);
  console.log('[comments test] Viewer created and replied to a thread; resolving another author’s thread was denied');
});

test('a removed member is denied access to comment routes', async () => {
  const owner = await registerUser();
  const member = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, member.email, 'viewer');
  const created = await createThread(member.token, board.id);
  assert.equal(created.status, 201);

  const removed = await authed(
    request(app).delete(`/api/boards/${board.id}/members/${member.user.id}`),
    owner.token,
  );
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  const denied = await createThread(member.token, board.id);
  assert.equal(denied.status, 403);
  console.log('[comments test] Removed member was rejected by the comment route');
});

test('deleting an anchored node orphans its thread without deleting it', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  const graph = {
    nodes: [{ id: 'comment-node', type: 'service', label: 'API', x: 100, y: 80, width: 208, height: 96 }],
    edges: [],
  };
  await Board.updateOne({ _id: board.id }, { $set: { graph } });
  await invalidateBoard(board.id);

  const created = await createThread(owner.token, board.id, {
    type: 'node', nodeId: 'comment-node', offsetX: 20, offsetY: 30,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const threadId = created.body.thread.id;

  await Board.updateOne({ _id: board.id }, { $set: { graph: { nodes: [], edges: [] } } });
  await invalidateBoard(board.id);
  const listed = await authed(request(app).get(`/api/boards/${board.id}/comments`), owner.token);

  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.threads.length, 1);
  assert.equal(listed.body.threads[0].id, threadId);
  assert.equal(listed.body.threads[0].orphaned, true);
  assert.ok(listed.body.threads[0].orphanedAt);
  assert.equal(await Comment.countDocuments({ boardId: board.id, threadId }), 1);
  console.log('[comments test] Deleted node left its comment thread stored and marked orphaned');
});

test('snapshot restore leaves comments intact because they are stored separately', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  await Board.updateOne(
    { _id: board.id },
    { $set: { graph: { nodes: [{
      id: 'snapshot-node', type: 'service', label: 'API', x: 0, y: 0,
      width: 208, height: 96, description: '', entities: [],
    }], edges: [] } } },
  );
  await invalidateBoard(board.id);

  const created = await createThread(owner.token, board.id, {
    type: 'node', nodeId: 'snapshot-node', offsetX: 10, offsetY: 10,
  }, 'Keep me through restore');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const threadId = created.body.thread.id;
  const snapshot = await createSnapshot(board.id, owner.user.id, { name: 'Before restore', kind: 'manual' });

  await Board.updateOne({ _id: board.id }, { $set: { graph: { nodes: [], edges: [] } } });
  await invalidateBoard(board.id);
  await restoreSnapshot(board.id, snapshot.id, owner.user.id);

  const listed = await authed(request(app).get(`/api/boards/${board.id}/comments`), owner.token);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.threads[0].id, threadId);
  assert.equal(listed.body.threads[0].text, 'Keep me through restore');
  console.log('[comments test] Snapshot restore preserved the separately stored comment thread');
});
