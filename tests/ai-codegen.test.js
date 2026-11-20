import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { app } from '../src/app.js';
import { Board } from '../src/models/Board.js';
import { analyzeGraph } from '../src/services/architectureAnalyzer.js';
import { interpretGraph } from '../src/services/codegenService.js';
import { authed, createBoard, registerUser, sampleGraph, setupDatabase, teardownDatabase } from './helpers.js';
import { invalidateBoard } from '../src/services/boardState.js';
import { clearAnalysisCache } from '../src/services/aiService.js';

before(setupDatabase);
after(teardownDatabase);

const parseZipLike = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

test('heuristic review flags client-to-database access as critical', () => {
  const review = analyzeGraph(sampleGraph);
  assert.equal(typeof review.score, 'number');
  assert.ok(review.score < 100);
  const critical = review.findings.find((finding) => finding.id === 'direct-database-access');
  assert.ok(critical, 'expected direct database access finding');
  assert.equal(critical.severity, 'critical');
  assert.deepEqual(critical.nodeIds.sort(), ['client', 'db']);
});

test('empty canvases return an explicit empty review', () => {
  const review = analyzeGraph({ nodes: [], edges: [] });
  assert.equal(review.score, null);
  assert.equal(review.rating, 'empty');
  assert.deepEqual(review.findings, []);
});

test('detects circular service dependencies', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'service', label: 'Orders Service', x: 0, y: 0 },
      { id: 'b', type: 'service', label: 'Payments Service', x: 0, y: 0 },
      { id: 'c', type: 'database', label: 'MongoDB', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'sync' },
      { id: 'e2', from: 'b', to: 'a', kind: 'sync' },
      { id: 'e3', from: 'a', to: 'c', kind: 'data' },
    ],
  };
  const review = analyzeGraph(graph);
  const cycle = review.findings.find((finding) => finding.id === 'service-cycle');
  assert.ok(cycle);
  assert.equal(cycle.severity, 'high');
});

test('analyze endpoint reviews the live board without an AI key', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token);
  await Board.updateOne({ _id: board.id }, { $set: { graph: sampleGraph, revision: 2 } });
  invalidateBoard(board.id);
  clearAnalysisCache();

  const response = await authed(
    request(app).post(`/api/boards/${board.id}/ai/analyze`),
    owner.token,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.review.provider, 'heuristic');
  assert.ok(response.body.review.summary.length > 20);
  assert.ok(response.body.review.findings.length > 0);
  assert.equal(response.body.revision, 2);
});

test('generates a MERN scaffold whose backend JavaScript parses', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token, { name: 'Payments Platform' });
  await Board.updateOne({ _id: board.id }, { $set: { graph: sampleGraph, revision: 2 } });
  invalidateBoard(board.id);

  const response = await authed(request(app).post(`/api/boards/${board.id}/generate`), owner.token);
  assert.equal(response.status, 200);

  const paths = response.body.files.map((file) => file.path);
  assert.ok(paths.includes('backend/package.json'));
  assert.ok(paths.includes('backend/src/server.js'));
  assert.ok(paths.includes('backend/src/models/User.js'));
  assert.ok(paths.includes('backend/src/models/Order.js'));
  assert.ok(paths.includes('frontend/src/App.jsx'));
  assert.equal(response.body.summary.entities.includes('User'), true);
  assert.equal(response.body.summary.hasAuth, false);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archflow-codegen-'));
  try {
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }));
    const jsFiles = response.body.files.filter((file) => file.path.endsWith('.js'));
    assert.ok(jsFiles.length > 0);

    for (const file of jsFiles) {
      const target = path.join(tempDir, file.path.replace(/\//g, '__'));
      await fs.writeFile(target, file.content);
      const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${file.path} failed to parse: ${result.stderr}`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('generator maps auth nodes to JWT scaffolding', () => {
  const graph = {
    nodes: [
      { id: 'auth', type: 'auth', label: 'Auth Service', x: 0, y: 0, entities: [] },
      { id: 'db', type: 'database', label: 'MongoDB', x: 0, y: 0, entities: ['Users', 'Sessions'] },
    ],
    edges: [{ id: 'e1', from: 'auth', to: 'db', kind: 'data' }],
  };
  const interpretation = interpretGraph(graph);
  assert.equal(interpretation.hasAuth, true);
  assert.ok(interpretation.entities.includes('User'));
  assert.ok(interpretation.entities.includes('Session'));
  assert.equal(interpretation.resources[0].path, 'users');
});

test('produces a downloadable zip archive', async () => {
  const owner = await registerUser();
  const board = await createBoard(owner.token, { name: 'Zip Test' });

  const response = await authed(
    request(app).post(`/api/boards/${board.id}/generate/download`),
    owner.token,
  )
    .buffer(true)
    .parse(parseZipLike);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/zip/);
  assert.match(response.headers['content-disposition'], /attachment; filename=".+\.zip"/);
  assert.equal(response.body.subarray(0, 2).toString(), 'PK', 'zip payload must start with the ZIP signature');
  assert.ok(response.body.length > 1000);
});
