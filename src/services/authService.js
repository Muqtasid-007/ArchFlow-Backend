import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import {
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  signAccessToken,
} from './tokenService.js';

const publicUser = (userDoc) => (typeof userDoc.toJSON === 'function' ? userDoc.toJSON() : userDoc);

export async function register({ name, email, password }) {
  const existing = await User.findByEmail(email);
  if (existing) throw ApiError.conflict('An account with that email already exists');

  const user = await User.create({ name, email, password });
  const accessToken = signAccessToken(user);
  const refresh = await createRefreshToken(user);

  return { user: publicUser(user), accessToken, refresh };
}

export async function login({ email, password }) {
  const user = await User.findByEmail(email).select('+password');
  if (!user) throw ApiError.unauthorized('Email or password is incorrect');

  const valid = await user.comparePassword(password);
  if (!valid) throw ApiError.unauthorized('Email or password is incorrect');

  user.lastActiveAt = new Date();
  await user.save({ validateBeforeSave: false });

  const accessToken = signAccessToken(user);
  const refresh = await createRefreshToken(user);
  return { user: publicUser(user), accessToken, refresh };
}

export async function refreshSession(rawToken) {
  const { user, refresh } = await rotateRefreshToken(rawToken);
  return { user: publicUser(user), accessToken: signAccessToken(user), refresh };
}

export async function logout(rawToken) {
  await revokeRefreshToken(rawToken);
}

export async function updateProfile(userId, updates) {
  const user = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound('Account not found');
  return publicUser(user);
}
