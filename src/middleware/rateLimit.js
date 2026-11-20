import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const baseOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Disable throttling during automated tests to keep them deterministic.
  skip: () => env.isTest,
  message: { error: { message: 'Too many requests, please slow down.', code: 'RATE_LIMITED' } },
};

/** Brute-force protection for credential endpoints. */
export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 25,
});

/** Broad protection for the REST API. */
export const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 240,
});

/** AI calls are expensive — keep them tightly budgeted per user/IP. */
export const aiLimiter = rateLimit({
  ...baseOptions,
  windowMs: 10 * 60 * 1000,
  limit: 30,
});
