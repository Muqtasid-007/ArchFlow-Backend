import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { Board } from '../src/models/Board.js';
import {
  authed,
  createBoard,
  inviteMember,
  registerUser,
  sampleGraph,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';
import { getBoardStateFromRedis, invalidateBoard } from '../src/services/boardState.js';

before(setupDatabase);
after(teardownDatabase);

test('creates a board with the creator as admin and lists it', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token, { name: 'Architecture Review' });

  assert.ok(board.id);
  assert.equal(board.name, 'Architecture Review');
  assert.equal(board.role, 'admin');

  const list = await authed(request(app).get('/api/boards'), owner.token);
  assert.equal(list.status, 200);
  const listed = list.body.boards.find((entry) => entry.id === board.id);
  assert.ok(listed);
  assert.equal(listed.role, 'admin');
  assert.equal(listed.graph, undefined, 'the board list must not ship full graphs');
});

test('enforces membership and role hierarchy', async () => {
  const owner = await registerUser();
  const editor = await registerUser();
  const viewer = await registerUser();
  const outsider = await registerUser();
  const board = await createBoard(owner.token);

  assert.equal((await inviteMember(owner.token, board.id, editor.email, 'editor')).status, 201);
  assert.equal((await inviteMember(owner.token, board.id, viewer.email, 'viewer')).status, 201);

  const outsiderRead = await authed(request(app).get(`/api/boards/${board.id}`), outsider.token);
  assert.equal(outsiderRead.status, 403);

  const editorRead = await authed(request(app).get(`/api/boards/${board.id}`), editor.token);
  assert.equal(editorRead.status, 200);
  assert.equal(editorRead.body.role, 'editor');

  const editorRename = await authed(request(app).patch(`/api/boards/${board.id}`), editor.token).send({
    name: 'Hijacked',
  });
  assert.equal(editorRename.status, 403, 'editors cannot rename a board');

  const viewerRename = await authed(request(app).patch(`/api/boards/${board.id}`), viewer.token).send({
    name: 'Hijacked',
  });
  assert.equal(viewerRename.status, 403);

  const ownerRename = await authed(request(app).patch(`/api/boards/${board.id}`), owner.token).send({
    name: 'Renamed Architecture',
  });
  assert.equal(ownerRename.status, 200);
  assert.equal(ownerRename.body.board.name, 'Renamed Architecture');
});

test('prevents duplicate invitations and unknown emails', async () => {
  const owner = await registerUser();
  const member = await registerUser();
  const board = await createBoard(owner.token);

  assert.equal((await inviteMember(owner.token, board.id, member.email, 'editor')).status, 201);
  assert.equal((await inviteMember(owner.token, board.id, member.email, 'viewer')).status, 409);
  assert.equal((await inviteMember(owner.token, board.id, 'nobody@nowhere.dev', 'viewer')).status, 404);
});

test('supports role changes and self-service departure', async () => {
  const owner = await registerUser();
  const member = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, member.email, 'viewer');

  const promote = await authed(
    request(app).patch(`/api/boards/${board.id}/members/${member.user.id}`),
    owner.token,
  ).send({ role: 'editor' });
  assert.equal(promote.status, 200);
  assert.equal(
    promote.body.board.members.find((entry) => entry.user.id === member.user.id).role,
    'editor',
  );

  const leave = await authed(
    request(app).delete(`/api/boards/${board.id}/members/${member.user.id}`),
    member.token,
  );
  assert.equal(leave.status, 204);

  const afterLeave = await authed(request(app).get(`/api/boards/${board.id}`), member.token);
  assert.equal(afterLeave.status, 403);
});

test('only the owner can delete a board', async () => {
  const owner = await registerUser();
  const member = await registerUser();
  const board = await createBoard(owner.token);
  await inviteMember(owner.token, board.id, member.email, 'admin');

  const attempt = await authed(request(app).delete(`/api/boards/${board.id}`), member.token);
  assert.equal(attempt.status, 403);

  const deleted = await authed(request(app).delete(`/api/boards/${board.id}`), owner.token);
  assert.equal(deleted.status, 204);

  const missing = await authed(request(app).get(`/api/boards/${board.id}`), owner.token);
  assert.equal(missing.status, 404);
});

test('captures and restores canvas snapshots', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);

  await Board.updateOne({ _id: board.id }, { $set: { graph: sampleGraph, revision: 3 } });
  invalidateBoard(board.id);

  const created = await authed(request(app).post(`/api/boards/${board.id}/snapshots`), owner.token).send({
    name: 'Before refactor',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.snapshot.nodeCount, 2);
  assert.equal(created.body.snapshot.edgeCount, 1);
  assert.equal(created.body.snapshot.graph, undefined, 'snapshot payloads stay lightweight');

  await Board.updateOne({ _id: board.id }, { $set: { graph: { nodes: [], edges: [] }, revision: 4 } });
  invalidateBoard(board.id);

  const list = await authed(request(app).get(`/api/boards/${board.id}/snapshots`), owner.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.snapshots.length, 1);

  const restored = await authed(
    request(app).post(`/api/boards/${board.id}/snapshots/${created.body.snapshot.id}/restore`),
    owner.token,
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.graph.nodes.length, 2);
  assert.ok(restored.body.revision > 4, 'restoring must bump the board revision');

  const [restoredMongo, restoredRedis] = await Promise.all([
    Board.findById(board.id).select('graph revision').lean(),
    getBoardStateFromRedis(board.id),
  ]);
  assert.equal(restoredMongo.revision, restored.body.revision);
  assert.deepEqual(restoredMongo.graph.nodes, restoredRedis.graph.nodes);
  assert.equal(restoredRedis.revision, restored.body.revision);

  const snapshotsAfterRestore = await authed(
    request(app).get(`/api/boards/${board.id}/snapshots`),
    owner.token,
  );
  assert.equal(
    snapshotsAfterRestore.body.snapshots.length,
    2,
    'restoring preserves the previous state as an automatic snapshot',
  );

  const viewer = await registerUser();
  await inviteMember(owner.token, board.id, viewer.email, 'viewer');
  const viewerSnapshot = await authed(
    request(app).post(`/api/boards/${board.id}/snapshots`),
    viewer.token,
  ).send({ name: 'Viewer attempt' });
  assert.equal(viewerSnapshot.status, 403);
});
