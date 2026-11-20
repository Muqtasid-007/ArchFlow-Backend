import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertManualSnapshotLimit,
  automaticSnapshotExcess,
} from '../src/services/snapshotService.js';

test('limits manual snapshots and trims only automatic snapshots beyond available slots', () => {
  assert.doesNotThrow(() => assertManualSnapshotLimit(49));
  assert.throws(() => assertManualSnapshotLimit(50), /at most 50 manual snapshots/i);

  assert.equal(automaticSnapshotExcess(0, 100), 0);
  assert.equal(automaticSnapshotExcess(50, 50), 0);
  assert.equal(automaticSnapshotExcess(50, 51), 1);
  assert.equal(automaticSnapshotExcess(40, 61), 1);
  console.log('[snapshot test] 50 manual limit enforced; automatic cleanup preserves manual history');
});
