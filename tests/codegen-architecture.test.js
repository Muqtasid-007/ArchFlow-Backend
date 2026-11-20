import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateProject, interpretGraph } from '../src/services/codegenService.js';

function nodeOf(id, type, label, entities = []) { return { id, type, label, entities }; }

async function assertGeneratedJavaScriptParses(files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archflow-adapters-'));
  try {
    for (const file of files.filter(({ path: filePath }) => filePath.endsWith('.js'))) {
      const destination = path.join(directory, file.path.replaceAll('/', '__'));
      await fs.writeFile(destination, file.content);
      const result = spawnSync(process.execPath, ['--check', destination], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${file.path} has invalid JavaScript: ${result.stderr}`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('generation follows individual service nodes and their direct data connections', () => {
  const graph = {
    nodes: [
      { id: 'web', type: 'frontend', label: 'React Web', entities: [] },
      { id: 'api', type: 'gateway', label: 'Express API', entities: [] },
      { id: 'orders', type: 'service', label: 'Order Service', entities: [] },
      { id: 'users', type: 'service', label: 'User Service', entities: [] },
      { id: 'orders-db', type: 'database', label: 'MongoDB Orders', entities: ['Orders'] },
      { id: 'users-db', type: 'database', label: 'MongoDB Users', entities: ['Users'] },
    ],
    edges: [
      { id: 'e1', from: 'web', to: 'api', kind: 'sync' },
      { id: 'e2', from: 'api', to: 'orders', kind: 'sync' },
      { id: 'e3', from: 'api', to: 'users', kind: 'sync' },
      { id: 'e4', from: 'orders', to: 'orders-db', kind: 'data' },
      { id: 'e5', from: 'users', to: 'users-db', kind: 'data' },
    ],
  };
  const result = interpretGraph(graph);
  assert.deepEqual(result.resources.map(({ name, model }) => [name, model]), [['Order', 'Order'], ['User', 'User']]);
  assert.equal(result.databases.length, 2);
  const generated = generateProject({ boardName: 'Orders', graph });
  assert.ok(generated.files.some(({ path }) => path === 'backend/src/routes/orders.routes.js'));
  assert.ok(generated.files.some(({ path }) => path === 'backend/src/routes/users.routes.js'));
  assert.equal(generated.summary.architecture.connections.length, 5);
  assert.ok(generated.summary.warnings.every((warning) => !warning.includes('disconnected')));
});

test('generation recommends missing or disconnected architecture components', () => {
  const generated = generateProject({
    boardName: 'Unwired',
    graph: { nodes: [
      { id: 'web', type: 'frontend', label: 'React Web' },
      { id: 'svc', type: 'service', label: 'Catalog Service' },
    ], edges: [] },
  });
  assert.ok(generated.summary.warnings.some((warning) => warning.includes('No database component')));
  assert.ok(generated.summary.warnings.some((warning) => warning.includes('No auth component')));
  assert.ok(generated.summary.warnings.some((warning) => warning.includes('disconnected')));
  assert.ok(generated.summary.warnings.some((warning) => warning.includes('No connection links')));
});

test('auth architecture generates refresh tokens and protects service routes', async () => {
  const generated = generateProject({
    boardName: 'Secure API',
    graph: {
      nodes: [
        { id: 'auth', type: 'auth', label: 'Identity Auth' },
        { id: 'service', type: 'service', label: 'Catalog Service' },
        { id: 'db', type: 'database', label: 'MongoDB', entities: ['Users', 'Catalog Items'] },
      ],
      edges: [
        { id: 'a1', from: 'auth', to: 'db', kind: 'data' },
        { id: 'a2', from: 'service', to: 'db', kind: 'data' },
      ],
    },
  });
  const byPath = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.match(byPath.get('backend/src/routes/auth.routes.js'), /router\.post\('\/refresh'/);
  const resourceRoute = `backend/src/routes/${generated.summary.resources[0].path}.routes.js`;
  assert.match(byPath.get(resourceRoute), /router\.use\(requireAuth\)/);
  assert.match(byPath.get('backend/src/middleware/auth.js'), /Access token required/);
  assert.match(byPath.get('backend/.env.example'), /JWT_REFRESH_SECRET=/);
  await assertGeneratedJavaScriptParses(generated.files);
});

test('generates a PostgreSQL-specific adapter and dependencies', () => {
  const generated = generateProject({
    boardName: 'Postgres board',
    graph: { nodes: [{ id: 'db', type: 'database', label: 'PostgreSQL' }], edges: [] },
  });
  assert.equal(generated.summary.architecture.databases[0].engine, 'postgresql');
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.match(files.get('backend/package.json'), /"pg"/);
  assert.match(files.get('backend/src/config/databases.js'), /from 'pg'/);
  assert.match(files.get('backend/.env.example'), /DATABASE_DB_URL=postgresql:/);
  assert.match(files.get('backend/README.md'), /Start PostgreSQL/);
  assert.doesNotMatch(files.get('backend/README.md'), /Start PostgreSQL and MongoDB/);
  assert.equal(files.has('backend/src/config/db.js'), false);
});

test('generates MongoDB driver and repository configuration', async () => {
  const generated = generateProject({ boardName: 'Mongo app', graph: { nodes: [nodeOf('mongo', 'database', 'MongoDB', ['Orders'])], edges: [] } });
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.match(files.get('backend/package.json'), /"mongodb"/);
  assert.match(files.get('backend/src/config/databases.js'), /MongoClient/);
  assert.match(files.get('backend/src/repositories/order.js'), /collection\(TABLE\)/);
  await assertGeneratedJavaScriptParses(generated.files);
});

test('generates MySQL pool, schema and dependency', async () => {
  const generated = generateProject({ boardName: 'Mysql app', graph: { nodes: [nodeOf('mysql', 'database', 'MySQL', ['Invoices'])], edges: [] } });
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.match(files.get('backend/package.json'), /"mysql2"/);
  assert.match(files.get('backend/src/config/databases.js'), /mysql2\/promise/);
  assert.match(files.get('backend/.env.example'), /mysql:\/\//);
  assert.match(files.get('backend/src/repositories/invoice.js'), /CREATE TABLE IF NOT EXISTS/);
  await assertGeneratedJavaScriptParses(generated.files);
});

test('Redis cache node adds a separate cache client and generated cache-aside CRUD', async () => {
  const generated = generateProject({
    boardName: 'Cached app',
    graph: { nodes: [nodeOf('mongo', 'database', 'MongoDB', ['Products']), nodeOf('products', 'service', 'Product Service'), nodeOf('redis-cache', 'cache', 'Redis Cache')], edges: [{ id: 'd1', from: 'products', to: 'mongo', kind: 'data' }, { id: 'c1', from: 'products', to: 'redis-cache', kind: 'data' }] },
  });
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  assert.match(files.get('backend/package.json'), /"redis"/);
  assert.match(files.get('backend/src/config/cache.js'), /createClient/);
  assert.match(files.get('backend/src/controllers/products.controller.js'), /cacheSet/);
  assert.match(files.get('backend/.env.example'), /CACHE_REDIS_URL/);
  await assertGeneratedJavaScriptParses(generated.files);
});

test('generates separate adapters and dependencies for mixed database architectures', async () => {
  const generated = generateProject({
    boardName: 'Mixed app',
    graph: { nodes: [
      nodeOf('postgres', 'database', 'PostgreSQL', ['Orders']),
      nodeOf('mysql', 'database', 'MySQL', ['Invoices']),
      nodeOf('redis-db', 'database', 'Redis', ['Sessions']),
      nodeOf('orders', 'service', 'Order Service'),
      nodeOf('billing', 'service', 'Billing Service'),
      nodeOf('sessions', 'service', 'Session Service'),
    ], edges: [
      { id: 'a', from: 'orders', to: 'postgres', kind: 'data' },
      { id: 'b', from: 'billing', to: 'mysql', kind: 'data' },
      { id: 'c', from: 'sessions', to: 'redis-db', kind: 'data' },
    ] },
  });
  const files = new Map(generated.files.map((file) => [file.path, file.content]));
  for (const dependency of ['pg', 'mysql2', 'redis']) assert.match(files.get('backend/package.json'), new RegExp(`"${dependency}"`));
  const config = files.get('backend/src/config/databases.js');
  assert.match(config, /from 'pg'/);
  assert.match(config, /mysql2\/promise/);
  assert.match(config, /from 'redis'/);
  assert.match(files.get('backend/src/repositories/session.js'), /connection\.engine === 'redis'/);
  assert.match(files.get('backend/src/repositories/order.js'), /DATABASE_KEY = 'postgres'/);
  assert.match(files.get('backend/src/repositories/invoice.js'), /DATABASE_KEY = 'mysql'/);
  assert.match(files.get('backend/src/repositories/session.js'), /DATABASE_KEY = 'redis-db'/);
  assert.equal(generated.summary.architecture.databases.length, 3);
  await assertGeneratedJavaScriptParses(generated.files);
});

test('unknown database components stop generation with an explicit error', () => {
  assert.throws(
    () => generateProject({ boardName: 'Unsupported', graph: { nodes: [nodeOf('db', 'database', 'DynamoDB')] } }),
    (error) => error.code === 'UNSUPPORTED_DATABASE' && error.statusCode === 422 && /Generation stopped/.test(error.message),
  );
});

test('unknown cache components stop generation instead of being treated as Redis', () => {
  assert.throws(
    () => generateProject({ boardName: 'Unsupported cache', graph: { nodes: [nodeOf('cache', 'cache', 'Memcached')] } }),
    (error) => error.code === 'UNSUPPORTED_CACHE' && error.statusCode === 422 && /Supported cache component: Redis/.test(error.message),
  );
});

test('a cache component does not replace the separately detected MongoDB database', () => {
  const generated = generateProject({
    boardName: 'Separate concerns',
    graph: { nodes: [nodeOf('mongo', 'database', 'MongoDB', ['Events']), nodeOf('cache', 'cache', 'Redis Cache')] },
  });
  assert.equal(generated.summary.generatedAdapters.length, 1);
  assert.equal(generated.summary.generatedAdapters[0].engine, 'mongodb');
  assert.equal(generated.summary.cache.engine, 'redis');
  const packageJson = JSON.parse(generated.files.find((file) => file.path === 'backend/package.json').content);
  assert.ok(packageJson.dependencies.mongodb);
  assert.ok(packageJson.dependencies.redis);
});

