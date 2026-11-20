import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeTestMongoUri } from './helpers.js';

test('allows a local MongoDB URI with a disposable _test database', () => {
  assert.equal(
    assertSafeTestMongoUri('mongodb://localhost:27017/archflow_test'),
    'mongodb://localhost:27017/archflow_test',
  );
});

test('rejects a remote MongoDB host before setup can drop a database', () => {
  assert.throws(
    () => assertSafeTestMongoUri('mongodb+srv://cluster.example/archflow_test'),
    /Unsafe MONGO_TEST_URI.*localhost or 127\.0\.0\.1/,
  );
});

test('rejects a local database without the _test suffix', () => {
  assert.throws(
    () => assertSafeTestMongoUri('mongodb://127.0.0.1:27017/archflow'),
    /database name ending in _test/,
  );
});

test('rejects malformed MongoDB URIs', () => {
  assert.throws(
    () => assertSafeTestMongoUri('not a MongoDB URI'),
    /valid MongoDB URI for a local database ending in _test/,
  );
});
