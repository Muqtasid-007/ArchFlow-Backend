import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTestRedisUrl } from '../src/config/testRedis.js';

test('defaults tests to local Redis database 15', () => {
  assert.equal(resolveTestRedisUrl(), 'redis://127.0.0.1:6380/15');
});

test('keeps a configured local non-default test database', () => {
  assert.equal(resolveTestRedisUrl('redis://localhost:6380/4'), 'redis://localhost:6380/4');
});

test('rejects remote Redis hosts', () => {
  assert.throws(
    () => resolveTestRedisUrl('redis://cache.example.com:6379/4'),
    /Unsafe TEST_REDIS_URL.*localhost or 127\.0\.0\.1/,
  );
});

test('rejects the default Redis database so tests cannot flush production-like data', () => {
  assert.throws(
    () => resolveTestRedisUrl('redis://127.0.0.1:6379/0'),
    /Redis database number above 0/,
  );
});
