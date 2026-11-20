// Keep retry timing in one place so board and sticky saves behave the same.
export const MAX_RETRY_DELAY_MS = 30_000;

export function retryDelayMs(attempt) {
  return Math.min(1_000 * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
}

/** Retry a durable save until it works, logging each failed attempt. */
export async function retryUntilSuccess(save, { onFailure, wait = delay } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await save();
    } catch (error) {
      attempt += 1;
      const delayMs = retryDelayMs(attempt);
      onFailure?.(error, { attempt, delayMs });
      await wait(delayMs);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
