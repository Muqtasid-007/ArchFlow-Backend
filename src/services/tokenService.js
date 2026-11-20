import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';

export const REFRESH_COOKIE = 'archflow_refresh';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function signAccessToken(user) {
  return jwt.sign({ type: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: String(user._id ?? user.id),
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: env.JWT_ISSUER,
    audience: 'archflow-api',
  });
}

export async function createRefreshToken(user) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user: user._id ?? user.id, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export function refreshCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/api/auth',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/**
 * Validates a refresh cookie, revokes it (single use) and mints a new pair.
 */
export async function rotateRefreshToken(rawToken) {
  if (!rawToken) throw ApiError.unauthorized('Refresh session missing');

  const record = await RefreshToken.findOne({ tokenHash: hashToken(rawToken), revokedAt: null }).populate('user');
  if (!record || !record.user || record.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Refresh session expired, please sign in again');
  }

  const next = await createRefreshToken(record.user);
  record.revokedAt = new Date();
  record.replacedBy = hashToken(next.token);
  await record.save();

  return { user: record.user, refresh: next };
}

export async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllUserTokens(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
