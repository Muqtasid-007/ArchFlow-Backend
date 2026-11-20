import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../src/app.js';
import { User } from '../src/models/User.js';
import {
  authed,
  cookieValue,
  registerUser,
  setupDatabase,
  teardownDatabase,
} from './helpers.js';

before(setupDatabase);
after(teardownDatabase);

test('registers a user, hashes the password and returns an access token', async () => {
  const email = `register-${Date.now()}@archflow.test`;
  const response = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Ada Lovelace', email, password: 'Secure123' });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.user.name, 'Ada Lovelace');
  assert.ok(response.body.accessToken);
  assert.equal(response.body.user.password, undefined);

  const stored = await User.findByEmail(email).select('+password');
  assert.ok(stored.password.startsWith('$2'), 'password must be stored as a bcrypt hash');
  assert.notEqual(stored.password, 'Secure123');

  const refreshCookie = cookieValue(response.headers['set-cookie'], 'archflow_refresh');
  assert.ok(refreshCookie, 'refresh cookie must be set');
  assert.match(response.headers['set-cookie'].join(';'), /HttpOnly/i);
});

test('rejects duplicate email addresses with 409', async () => {
  const user = await registerUser();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Another Name', email: user.email, password: 'Password123' });

  assert.equal(response.status, 409);
});

test('validates weak passwords field by field', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Weak Pass', email: 'weak@archflow.test', password: 'short' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'BAD_REQUEST');
  assert.ok(Array.isArray(response.body.error.details));
  assert.ok(response.body.error.details.some((detail) => detail.path === 'password'));
});

test('rejects invalid credentials without leaking which field failed', async () => {
  const user = await registerUser();
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: 'WrongPassword1' });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.message, 'Email or password is incorrect');
});

test('logs in and returns the current profile', async () => {
  const user = await registerUser({ name: 'Grace Hopper' });

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken);

  const me = await authed(request(app).get('/api/auth/me'), login.body.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, user.email);
  assert.equal(me.body.user.name, 'Grace Hopper');
});

test('requires authentication for the profile endpoint', async () => {
  const response = await request(app).get('/api/auth/me');
  assert.equal(response.status, 401);
});

test('rotates refresh tokens and rejects replay of the used token', async () => {
  const agent = request.agent(app);
  const email = `rotate-${Date.now()}@archflow.test`;
  const registration = await agent
    .post('/api/auth/register')
    .send({ name: 'Refresh Tester', email, password: 'Password123' });

  assert.equal(registration.status, 201);
  const firstCookie = cookieValue(registration.headers['set-cookie'], 'archflow_refresh');
  assert.ok(firstCookie);

  const refreshed = await agent.post('/api/auth/refresh');
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.accessToken);

  const replay = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
  assert.equal(replay.status, 401, 'a rotated refresh token must not be reusable');
});

test('logout revokes the refresh token', async () => {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/register')
    .send({ name: 'Logout Tester', email: `logout-${Date.now()}@archflow.test`, password: 'Password123' });

  const logout = await agent.post('/api/auth/logout');
  assert.equal(logout.status, 204);

  const refreshed = await agent.post('/api/auth/refresh');
  assert.equal(refreshed.status, 401);
});
