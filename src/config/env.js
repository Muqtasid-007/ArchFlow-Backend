import 'dotenv/config';
import { z } from 'zod';
import { resolveTestRedisUrl } from './testRedis.js';

const DEV_ACCESS_SECRET = 'dev-only-access-secret-do-not-use-in-production';
const DEV_REFRESH_SECRET = 'dev-only-refresh-secret-do-not-use-in-production';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/archflow'),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  CLIENT_ORIGIN: z.string().default('http://localhost:3000'),

  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),
  // Optional override for the refresh-cookie Secure flag. Defaults to on in
  // production; set false only when intentionally serving plain HTTP.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),

  AI_PROVIDER: z.enum(['auto', 'gemini', 'openai', 'none']).default('auto'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(3000).max(120000).default(25000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';
// In test mode, never inherit REDIS_URL from backend/.env. Tests use their own
// local Redis endpoint and a non-default database so cleanup stays isolated.
const redisUrl = raw.NODE_ENV === 'test'
  ? resolveTestRedisUrl(process.env.TEST_REDIS_URL)
  : raw.REDIS_URL;

if (isProduction) {
  const missing = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].filter((key) => !raw[key] || raw[key].length < 32);
  if (missing.length > 0) {
    throw new Error(
      `Production requires ${missing.join(', ')} set to a value of at least 32 characters. ` +
        'Generate one with: openssl rand -hex 48',
    );
  }
}

export const env = Object.freeze({
  ...raw,
  REDIS_URL: redisUrl,
  JWT_ACCESS_SECRET: raw.JWT_ACCESS_SECRET || DEV_ACCESS_SECRET,
  JWT_REFRESH_SECRET: raw.JWT_REFRESH_SECRET || DEV_REFRESH_SECRET,
  JWT_ISSUER: 'archflow',
  isProduction,
  isTest: raw.NODE_ENV === 'test',
  COOKIE_SECURE: raw.COOKIE_SECURE ? raw.COOKIE_SECURE === 'true' : isProduction,
  allowedOrigins: raw.CLIENT_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});

export const usingDevSecrets =
  env.JWT_ACCESS_SECRET === DEV_ACCESS_SECRET || env.JWT_REFRESH_SECRET === DEV_REFRESH_SECRET;
