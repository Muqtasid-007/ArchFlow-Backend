const DEFAULT_TEST_REDIS_URL = 'redis://127.0.0.1:6380/15';

/** Keep test connections local and in a non-default Redis database. */
export function resolveTestRedisUrl(value) {
  const urlValue = value || DEFAULT_TEST_REDIS_URL;
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error('TEST_REDIS_URL must be a valid local Redis URL using database 1 or higher.');
  }

  const database = parsed.pathname.replace(/^\/+/, '') || '15';
  if (!['redis:', 'rediss:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1'].includes(parsed.hostname.toLowerCase())
      || !/^\d+$/.test(database)
      || Number(database) === 0) {
    throw new Error(
      'Unsafe TEST_REDIS_URL: use localhost or 127.0.0.1 and a Redis database number above 0.',
    );
  }

  // If a local URL omitted its DB number, isolate it in DB 15 by default.
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

