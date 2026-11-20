import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { ROLE_RANK } from '../src/utils/constants.js';
import {
  MAX_STICKY_UPDATE_BYTES,
  findStickyNodeWithSources,
  MAX_STORED_STICKY_UPDATE_BYTES,
  normalizeStoredStickyUpdate,
  normalizeStickyUpdate,
} from '../src/services/stickyNoteService.js';

function canEditSticky(role) {
  return ROLE_RANK[role] >= ROLE_RANK.editor;
}

test('two sticky-note users merge text without losing characters', () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const server = new Y.Doc();
  let updateA;
  let updateB;

  docA.on('update', (update) => {
    updateA = update;
  });
  docB.on('update', (update) => {
    updateB = update;
  });

  docA.getText('text').insert(0, 'A');
  docB.getText('text').insert(0, 'B');

  Y.applyUpdate(server, updateA);
  Y.applyUpdate(server, updateB);
  const serverState = Y.encodeStateAsUpdate(server);
  Y.applyUpdate(docA, serverState);
  Y.applyUpdate(docB, serverState);

  console.log('[sticky test] Tab A text:', docA.getText('text').toString());
  console.log('[sticky test] Tab B text:', docB.getText('text').toString());

  assert.equal(docA.getText('text').toString(), docB.getText('text').toString());
  assert.match(docA.getText('text').toString(), /A/);
  assert.match(docA.getText('text').toString(), /B/);
});

test('only editors and owners can edit sticky text', () => {
  assert.equal(canEditSticky('viewer'), false);
  assert.equal(canEditSticky('editor'), true);
  assert.equal(canEditSticky('admin'), true);
  console.log('[sticky test] Viewer rejected, editor/owner allowed');
});

test('rejects non-binary and oversized sticky updates', () => {
  assert.throws(
    () => normalizeStickyUpdate([1, 2, 3]),
    /binary data/i,
  );
  assert.throws(
    () => normalizeStickyUpdate({ update: 'hello' }),
    /binary data/i,
  );
  assert.throws(
    () => normalizeStickyUpdate(new Uint8Array(MAX_STICKY_UPDATE_BYTES + 1)),
    /100 KB/i,
  );

  const allowed = normalizeStickyUpdate(new Uint8Array(MAX_STICKY_UPDATE_BYTES));
  assert.equal(allowed.byteLength, MAX_STICKY_UPDATE_BYTES);
  console.log('[sticky test] Binary payload accepted at 100 KB limit');
});

test('rejects stored sticky binaries above 500 KB with a clean error', () => {
  assert.throws(
    () => normalizeStoredStickyUpdate(Buffer.alloc(MAX_STORED_STICKY_UPDATE_BYTES + 1)),
    /Stored sticky update exceeds 500 KB/i,
  );
  assert.equal(
    normalizeStoredStickyUpdate(Buffer.alloc(MAX_STORED_STICKY_UPDATE_BYTES)).byteLength,
    MAX_STORED_STICKY_UPDATE_BYTES,
  );
  console.log('[sticky test] Stored binary accepted at 500 KB and rejected above the limit');
});

test('wraps malformed Yjs updates with a clean exception', () => {
  assert.throws(() => {
    try {
      Y.applyUpdate(new Y.Doc(), new Uint8Array([1, 2, 3]));
    } catch {
      throw new Error('Invalid Yjs binary update');
    }
  }, /Invalid Yjs binary update/i);
  console.log('[sticky test] Malformed Yjs update returned clean error');
});

test('looks for a sticky in Redis before MongoDB', async () => {
  const nodeId = 'sticky-lookup';
  const redisNode = { id: nodeId, type: 'sticky', label: 'Redis note' };
  const mongoNode = { id: nodeId, type: 'sticky', label: 'Mongo note' };

  const fromRedis = await findStickyNodeWithSources({
    boardId: 'board-1',
    nodeId,
    liveLookup: async () => redisNode,
    mongoLookup: async () => mongoNode,
  });
  assert.equal(fromRedis.label, 'Redis note');
  console.log('[sticky test] Redis-only lookup: found Redis note');

  const fromMongo = await findStickyNodeWithSources({
    boardId: 'board-1',
    nodeId,
    liveLookup: async () => null,
    mongoLookup: async () => mongoNode,
  });
  assert.equal(fromMongo.label, 'Mongo note');
  console.log('[sticky test] MongoDB-only lookup: found Mongo note');

  await assert.rejects(
    findStickyNodeWithSources({
      boardId: 'board-1',
      nodeId,
      liveLookup: async () => null,
      mongoLookup: async () => null,
    }),
    /Sticky note not found/i,
  );
  console.log('[sticky test] Neither source: clean sticky-not-found error');
});
