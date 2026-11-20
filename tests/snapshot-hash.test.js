import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/models/Board.js';
import { Snapshot } from '../src/models/Snapshot.js';
import { createSnapshot, MAX_SNAPSHOT_GRAPH_BYTES } from '../src/services/snapshotService.js';
import { createBoard, registerUser, setupDatabase, teardownDatabase } from './helpers.js';

before(setupDatabase);
after(teardownDatabase);

test('reuses the latest snapshot for an unchanged graph and saves changed graphs', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);

  const first = await createSnapshot(board.id, owner.user.id, { name: 'First' });
  const unchanged = await createSnapshot(board.id, owner.user.id, { name: 'Duplicate' });
  assert.equal(unchanged.id, first.id);
  assert.equal(await Snapshot.countDocuments({ board: board.id }), 1);

  await Board.updateOne(
    { _id: board.id },
    { $set: { graph: { nodes: [{
      id: 'node-1', type: 'service', label: 'Changed', x: 0, y: 0,
      width: 208, height: 96, description: '', entities: [],
    }], edges: [] } } },
  );
  const changed = await createSnapshot(board.id, owner.user.id, { name: 'Changed graph' });
  assert.notEqual(changed.id, first.id);
  assert.equal(await Snapshot.countDocuments({ board: board.id }), 2);
  console.log('[snapshot test] Identical graph reused latest snapshot; changed graph created a new one');
});

test('rejects a snapshot over 8 MB without inserting a record', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  await Board.updateOne(
    { _id: board.id },
    { $set: { graph: { nodes: [{
      id: 'large-sticky', type: 'sticky', label: 'Large note', x: 0, y: 0,
      width: 208, height: 96, description: '', entities: [],
      stickyUpdate: Buffer.alloc(MAX_SNAPSHOT_GRAPH_BYTES + 1),
    }], edges: [] } } },
  );

  await assert.rejects(
    createSnapshot(board.id, owner.user.id, { name: 'Too large' }),
    /Snapshot graph exceeds the 8 MB size limit/i,
  );
  assert.equal(await Snapshot.countDocuments({ board: board.id }), 0);
  console.log('[snapshot test] Graph over 8 MB rejected before a snapshot was inserted');
});
