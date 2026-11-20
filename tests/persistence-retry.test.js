import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelayMs, retryUntilSuccess } from '../src/utils/retry.js';

test('retries a simulated Mongo save failure with exponential backoff', async () => {
  let mongoAttempts = 0;
  const loggedFailures = [];
  const waits = [];

  const result = await retryUntilSuccess(async () => {
    mongoAttempts += 1;
    if (mongoAttempts === 1) {
      throw new Error('simulated MongoDB write failure');
    }
    return 'saved';
  }, {
    // Keep this test fast while checking the same delays production uses.
    wait: async (ms) => waits.push(ms),
    onFailure: (error, details) => loggedFailures.push({ error, ...details }),
  });

  assert.equal(result, 'saved');
  assert.equal(mongoAttempts, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(loggedFailures[0].error.message, 'simulated MongoDB write failure');
  assert.equal(loggedFailures[0].attempt, 1);
  assert.equal(loggedFailures[0].delayMs, 1_000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(retryDelayMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  );
  console.log('[persistence test] Mongo save failed once, logged, then succeeded after 1000 ms');
});
