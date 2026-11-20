import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMENT_WRITES_PER_SOCKET_PER_MINUTE,
  consumeCommentWrite,
} from '../src/realtime/commentRateLimit.js';

test('limits comment writes per socket and allows writes after the fixed window', () => {
  const socket = { data: {} };
  const now = 1_000_000;
  for (let i = 0; i < COMMENT_WRITES_PER_SOCKET_PER_MINUTE; i += 1) {
    assert.equal(consumeCommentWrite(socket, now), true);
  }
  assert.equal(consumeCommentWrite(socket, now), false);
  assert.equal(consumeCommentWrite(socket, now + 60_000), true);
  console.log('[comments socket test] Per-socket write limit enforced and reset after one minute');
});
