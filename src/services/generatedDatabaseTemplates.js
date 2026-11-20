export function databaseDependencies(databases, hasCache) {
  const deps = {};
  const engines = new Set(databases.map(({ engine }) => engine));
  if (engines.has('mongodb')) deps.mongodb = '^6.12.0';
  if (engines.has('postgresql')) deps.pg = '^8.13.1';
  if (engines.has('mysql')) deps.mysql2 = '^3.11.5';
  if (engines.has('redis') || hasCache) deps.redis = '^4.7.0';
  return deps;
}

export function databaseEnvironment(databases, hasCache) {
  return [
    ...databases.map(({ envKey, engine, label }) => `${envKey}=${{
      mongodb: `mongodb://127.0.0.1:27017/${label.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'app'}`,
      postgresql: 'postgresql://postgres:postgres@localhost:5432/app',
      mysql: 'mysql://root:password@localhost:3306/app',
      redis: 'redis://127.0.0.1:6379',
    }[engine]}`),
    ...(hasCache ? ['CACHE_REDIS_URL=redis://127.0.0.1:6379'] : []),
  ];
}

export function databaseConfigTemplate(databases) {
  const imports = [];
  const setup = [];
  const handles = [];
  const close = [];
  for (const database of databases) {
    const variable = `process.env.${database.envKey}`;
    if (database.engine === 'mongodb') {
      imports.push("import { MongoClient } from 'mongodb';");
      setup.push(`  { const client = new MongoClient(${variable}); await client.connect(); connections.set('${database.key}', { engine: 'mongodb', db: client.db() }); closers.push(() => client.close()); }`);
    } else if (database.engine === 'postgresql') {
      imports.push("import pg from 'pg';");
      setup.push(`  { const pool = new pg.Pool({ connectionString: ${variable} }); await pool.query('SELECT 1'); connections.set('${database.key}', { engine: 'postgresql', client: pool }); closers.push(() => pool.end()); }`);
    } else if (database.engine === 'mysql') {
      imports.push("import mysql from 'mysql2/promise';");
      setup.push(`  { const pool = mysql.createPool(${variable}); await pool.query('SELECT 1'); connections.set('${database.key}', { engine: 'mysql', client: pool }); closers.push(() => pool.end()); }`);
    } else if (database.engine === 'redis') {
      imports.push("import { createClient } from 'redis';");
      setup.push(`  { const client = createClient({ url: ${variable} }); client.on('error', (error) => console.error('Redis error', error)); await client.connect(); connections.set('${database.key}', { engine: 'redis', client }); closers.push(() => client.quit()); }`);
    }
  }
  return [
    ...new Set(imports), '',
    'const connections = new Map();',
    'const closers = [];',
    'export function getDatabase(key) {',
    '  const connection = connections.get(key);',
    "  if (!connection) throw new Error(`Database connection '${key}' is not initialized`);",
    '  return connection;',
    '}',
    '',
    'export async function connectDatabases() {',
    ...setup,
    "  console.log(`Connected to ${connections.size} database(s)`);",
    '}',
    '',
    'export async function closeDatabases() {',
    '  await Promise.allSettled(closers.map((close) => close()));',
    '}',
  ].join('\n');
}

export function cacheConfigTemplate() {
  return [
    "import { createClient } from 'redis';", '',
    'export const cache = createClient({ url: process.env.CACHE_REDIS_URL || \'redis://127.0.0.1:6379\' });',
    "cache.on('error', (error) => console.error('Redis cache error', error));",
    'export async function connectCache() { if (!cache.isOpen) await cache.connect(); }',
    'export async function closeCache() { if (cache.isOpen) await cache.quit(); }',
    'export async function cacheGet(key) { const value = await cache.get(key); return value == null ? null : JSON.parse(value); }',
    'export async function cacheSet(key, value, ttlSeconds = 60) { await cache.set(key, JSON.stringify(value), { EX: ttlSeconds }); }',
    'export async function cacheDelete(key) {',
    "  if (!key.includes('*')) return cache.del(key);",
    '  const keys = []; for await (const matched of cache.scanIterator({ MATCH: key })) keys.push(matched);',
    '  if (keys.length) await cache.del(keys);',
    '}',
  ].join('\n');
}

export function repositoryTemplate({ database, table }) {
  return [
    "import { randomUUID } from 'node:crypto';",
    "import { getDatabase } from '../config/databases.js';", '',
    `const DATABASE_KEY = '${database.key}';`,
    `const TABLE = '${table}';`,
    "const FIELDS = ['name', 'description', 'status', 'email', 'passwordHash', 'role'];",
    'const clean = (row) => {',
    '  if (!row) return null;',
    '  const value = { ...row, _id: String(row.id ?? row._id) };',
    '  if (value.password_hash !== undefined) { value.passwordHash = value.password_hash; delete value.password_hash; }',
    '  if (value.created_at !== undefined) { value.createdAt = value.created_at; delete value.created_at; }',
    '  if (value.updated_at !== undefined) { value.updatedAt = value.updated_at; delete value.updated_at; }',
    '  return value;',
    '};',
    'const sqlName = (name, engine) => engine === \'mysql\' ? `\\`${name}\\`` : `"${name}"`;',
    'let schemaReady;',
    'async function ensureSchema(connection) {',
    '  schemaReady ??= (async () => {',
    "    if (connection.engine === 'mongodb') { if (TABLE === 'user') await connection.db.collection(TABLE).createIndex({ email: 1 }, { unique: true }); return; }",
    "    if (connection.engine === 'redis') return;",
    "    const id = connection.engine === 'mysql' ? 'VARCHAR(36)' : 'VARCHAR(36)';",
    "    const text = connection.engine === 'mysql' ? 'TEXT' : 'TEXT';",
    "    const time = connection.engine === 'mysql' ? 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP' : 'TIMESTAMPTZ NOT NULL DEFAULT NOW()';",
    '    const tableName = sqlName(TABLE, connection.engine);',
    "    const email = TABLE === 'user' ? 'VARCHAR(320) UNIQUE' : 'VARCHAR(320)';",
    "    await connection.client.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id ${id} PRIMARY KEY, name VARCHAR(255), description ${text}, status VARCHAR(40), email ${email}, password_hash VARCHAR(255), role VARCHAR(40), created_at ${time}, updated_at ${time})`);",
    '  })();',
    '  return schemaReady;',
    '}',
    'function sql(connection, statement, values) {',
    "  if (connection.engine !== 'postgresql') return connection.client.query(statement, values);",
    '  let index = 0; return connection.client.query(statement.replace(/\\?/g, () => `$${++index}`), values);',
    '}',
    'function placeholders(connection, length) { return Array.from({ length }, (_v, index) => connection.engine === \'postgresql\' ? `$${index + 1}` : \'?\').join(\', \'); }',
    'export async function list(filter = {}) {',
    '  const connection = getDatabase(DATABASE_KEY); await ensureSchema(connection);',
    "  if (connection.engine === 'mongodb') return (await connection.db.collection(TABLE).find(filter).sort({ createdAt: -1 }).limit(200).toArray()).map(clean);",
    "  if (connection.engine === 'redis') { const ids = await connection.client.sMembers(`${TABLE}:ids`); const rows = await Promise.all(ids.map((id) => connection.client.get(`${TABLE}:${id}`))); return rows.filter(Boolean).map((row) => JSON.parse(row)).filter((row) => !filter.status || row.status === filter.status).slice(0, 200).map(clean); }",
    "  const tableName = sqlName(TABLE, connection.engine); const result = await sql(connection, `SELECT * FROM ${tableName}${filter.status ? ' WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 200`, filter.status ? [filter.status] : []); return result[0]?.map(clean) ?? result.rows.map(clean);",
    '}',
    'export async function getById(id) {',
    '  const connection = getDatabase(DATABASE_KEY); await ensureSchema(connection);',
    "  if (connection.engine === 'mongodb') return clean(await connection.db.collection(TABLE).findOne({ id }));",
    "  if (connection.engine === 'redis') { const row = await connection.client.get(`${TABLE}:${id}`); return row ? clean(JSON.parse(row)) : null; }",
    "  const result = await sql(connection, `SELECT * FROM ${sqlName(TABLE, connection.engine)} WHERE id = ?`, [id]); return clean(result[0]?.[0] ?? result.rows[0]);",
    '}',
    'export async function findByEmail(email) {',
    '  const connection = getDatabase(DATABASE_KEY); await ensureSchema(connection); const normalized = String(email).toLowerCase();',
    "  if (connection.engine === 'mongodb') return clean(await connection.db.collection(TABLE).findOne({ email: normalized }));",
    "  if (connection.engine === 'redis') { const rows = await list(); return rows.find((row) => row.email === normalized) ?? null; }",
    "  const result = await sql(connection, `SELECT * FROM ${sqlName(TABLE, connection.engine)} WHERE email = ? LIMIT 1`, [normalized]); return clean(result[0]?.[0] ?? result.rows[0]);",
    '}',
    'export async function create(input) {',
    '  const connection = getDatabase(DATABASE_KEY); await ensureSchema(connection);',
    '  const now = new Date(); const row = { id: randomUUID(), name: input.name ?? null, description: input.description ?? null, status: input.status ?? \'active\', email: input.email ? String(input.email).toLowerCase() : null, passwordHash: input.passwordHash ?? null, role: input.role ?? \'member\', createdAt: now, updatedAt: now };',
    "  if (connection.engine === 'mongodb') await connection.db.collection(TABLE).insertOne(row);",
    "  else if (connection.engine === 'redis') { await connection.client.set(`${TABLE}:${row.id}`, JSON.stringify(row)); await connection.client.sAdd(`${TABLE}:ids`, row.id); }",
    '  else { const columns = [\'id\', ...FIELDS.map((field) => field === \'passwordHash\' ? \'password_hash\' : field), \'created_at\', \'updated_at\']; const values = [row.id, ...FIELDS.map((field) => row[field]), now, now]; await sql(connection, `INSERT INTO ${sqlName(TABLE, connection.engine)} (${columns.map((column) => sqlName(column, connection.engine)).join(\', \')}) VALUES (${placeholders(connection, values.length)})`, values); }',
    '  return clean(row);',
    '}',
    'export async function update(id, input) {',
    '  const current = await getById(id); if (!current) return null; const connection = getDatabase(DATABASE_KEY);',
    '  const patch = Object.fromEntries(FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, input[field]])); const next = { ...current, ...patch, updatedAt: new Date() };',
    "  if (connection.engine === 'mongodb') await connection.db.collection(TABLE).updateOne({ id }, { $set: next });",
    "  else if (connection.engine === 'redis') await connection.client.set(`${TABLE}:${id}`, JSON.stringify(next));",
    '  else { const entries = Object.entries(patch); const assignments = entries.map(([field], index) => `${sqlName(field === \'passwordHash\' ? \'password_hash\' : field, connection.engine)} = ${connection.engine === \'postgresql\' ? `$${index + 1}` : \'?\'}`); if (assignments.length) await sql(connection, `UPDATE ${sqlName(TABLE, connection.engine)} SET ${assignments.join(\', \')}, updated_at = CURRENT_TIMESTAMP WHERE id = ${connection.engine === \'postgresql\' ? `$${entries.length + 1}` : \'?\'}`, [...entries.map(([, value]) => value), id]); }',
    '  return next;',
    '}',
    'export async function remove(id) {',
    '  const current = await getById(id); if (!current) return null; const connection = getDatabase(DATABASE_KEY);',
    "  if (connection.engine === 'mongodb') await connection.db.collection(TABLE).deleteOne({ id });",
    "  else if (connection.engine === 'redis') { await connection.client.del(`${TABLE}:${id}`); await connection.client.sRem(`${TABLE}:ids`, id); }",
    '  else await sql(connection, `DELETE FROM ${sqlName(TABLE, connection.engine)} WHERE id = ?`, [id]);',
    '  return current;',
    '}',
  ].join('\n');
}

export function modelTemplate({ entity, database, table }) {
  return [
    `export { list, getById, findByEmail, create, update, remove } from '../repositories/${table}.js';`,
  ].join('\n');
}

