import * as authService from '../services/authService.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../services/tokenService.js';

function setRefreshCookie(res, refresh) {
  res.cookie(REFRESH_COOKIE, refresh.token, refreshCookieOptions(refresh.expiresAt));
}

export async function register(req, res) {
  const { user, accessToken, refresh } = await authService.register(req.body);
  setRefreshCookie(res, refresh);
  res.status(201).json({ user, accessToken });
}

export async function login(req, res) {
  const { user, accessToken, refresh } = await authService.login(req.body);
  setRefreshCookie(res, refresh);
  res.json({ user, accessToken });
}

export async function refreshSession(req, res) {
  const { user, accessToken, refresh } = await authService.refreshSession(req.cookies?.[REFRESH_COOKIE]);
  setRefreshCookie(res, refresh);
  res.json({ user, accessToken });
}

export async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.status(204).end();
}

export async function me(req, res) {
  res.json({ user: req.user.toJSON() });
}

export async function updateMe(req, res) {
  const user = await authService.updateProfile(req.user._id, req.body);
  res.json({ user });
}
