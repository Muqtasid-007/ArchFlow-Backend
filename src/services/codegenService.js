import JSZip from 'jszip';
import {
  cacheConfigTemplate,
  databaseConfigTemplate,
  databaseDependencies,
  databaseEnvironment,
  repositoryTemplate,
} from './generatedDatabaseTemplates.js';

/**
 * Compiles the canvas graph into a runnable full-stack starter project.
 *
 * Decisions are derived from what is actually on the board: database nodes
 * contribute entities/models, service and auth nodes contribute API resources,
 * and an auth node adds JWT scaffolding. Database engines are selected from
 * database-node metadata and each generated repository binds to its connected store.
 */

const TECH_WORDS = new Set([
  'mongodb', 'mongo', 'db', 'database', 'datastore', 'postgres', 'postgresql', 'mysql', 'sql',
  'redis', 'cache', 'cluster', 'primary', 'replica', 'replicaset', 'shard', 'node', 'nodes',
  'server', 'service', 'services', 'api', 'apis', 'gateway', 'load', 'balancer', 'proxy',
  'queue', 'broker', 'kafka', 'rabbitmq', 'sqs', 'worker', 'workers', 'job', 'jobs',
  'bucket', 'storage', 's3', 'blob', 'auth', 'identity', 'provider', 'iam', 'sso',
  'client', 'clients', 'web', 'app', 'frontend', 'ui', 'react', 'vite', 'express',
  'elasticsearch', 'search', 'cdn', 'mail', 'notification', 'notifications', 'third',
  'party', 'external', 'legacy', 'main', 'core', 'backend',
]);

const splitWords = (value) =>
  String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

const toPascal = (value) =>
  splitWords(value)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('') || 'Item';

const toCamel = (value) => {
  const pascal = toPascal(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

const toKebab = (value) => splitWords(value).map((word) => word.toLowerCase()).join('-');

const singular = (word) => {
  const lower = String(word);
  if (lower.length <= 3) return lower;
  if (/ies$/i.test(lower)) return lower.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/i.test(lower)) return lower.slice(0, -2);
  if (/s$/i.test(lower) && !/ss$/i.test(lower)) return lower.slice(0, -1);
  return lower;
};

const pluralize = (word) => {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
};

const asciiSlug = (value) => toKebab(value) || 'archflow-app';

const languageOf = (path) => {
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  return 'markdown';
};

function createFileMap() {
  const files = [];
  return {
    add(path, content) {
      files.push({ path, content: content.endsWith('\n') ? content : content + '\n', language: languageOf(path) });
    },
    list() {
      return files;
    },
  };
}

// ---------------------------------------------------------------------------
// Graph interpretation
// ---------------------------------------------------------------------------

function meaningfulWords(label) {
  return splitWords(label).filter((word) => !TECH_WORDS.has(word.toLowerCase()));
}

function connectedNodes(nodeId, graph) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => nodeMap.get(edge.from === nodeId ? edge.to : edge.from))
    .filter(Boolean);
}

/** Nearest database reachable from a service, used to bind routers to models. */
function nearestDatabase(node, graph, nodesById) {
  const visited = new Set([node.id]);
  const queue = [node.id];
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    for (const nextId of adjacency.get(current) ?? []) {
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      const next = nodesById.get(nextId);
      if (next?.type === 'database') return next;
      queue.push(nextId);
    }
  }
  return null;
}

export function interpretGraph(graph) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const hasAuth = nodes.some((node) => node.type === 'auth');
  const databases = nodes.filter((node) => node.type === 'database');
  const databaseEngines = databases.map((node) => {
    const descriptor = `${node.label} ${node.description ?? ''}`.toLowerCase();
    if (/postgres|postgresql|\bpgsql\b/.test(descriptor)) return 'postgresql';
    if (/\bmysql\b|mariadb/.test(descriptor)) return 'mysql';
    if (/\bredis\b/.test(descriptor)) return 'redis';
    if (/mongo/.test(descriptor)) return 'mongodb';
    return null;
  });
  const connected = (left, right) => edges.some((edge) =>
    (edge.from === left && edge.to === right) || (edge.from === right && edge.to === left));

  const entityOrder = [];
  const entityDatabase = new Map();
  const entityNames = new Map();
  const addEntity = (raw) => {
    const words = meaningfulWords(raw);
    if (words.length === 0) return null;
    const pascal = singular(toPascal(words.join(' ')));
    const key = pascal.toLowerCase();
    if (!entityNames.has(key)) {
      entityNames.set(key, pascal);
      entityOrder.push(pascal);
    }
    return entityNames.get(key);
  };

  for (const node of databases) {
    if (node.entities?.length) {
      node.entities.forEach((entity) => { const model = addEntity(entity); if (model) entityDatabase.set(model, node.id); });
      continue;
    }
    let added = meaningfulWords(node.label).map(addEntity).filter(Boolean);
    added.forEach((model) => entityDatabase.set(model, node.id));
    if (added.length === 0) {
      added = connectedNodes(node.id, { nodes, edges })
        .flatMap((neighbor) => meaningfulWords(neighbor.label))
        .map(addEntity)
        .filter(Boolean);
      added.forEach((model) => entityDatabase.set(model, node.id));
    }
    if (added.length === 0) addEntity('Record');
  }

  if (hasAuth) addEntity('User');
  if (hasAuth) {
    const authNode = nodes.find((node) => node.type === 'auth');
    const authDatabase = authNode && (databases.find((candidate) => connected(authNode.id, candidate.id))
      ?? nearestDatabase(authNode, { nodes, edges }, nodesById));
    if (authDatabase) entityDatabase.set('User', authDatabase.id);
  }

  if (entityOrder.length === 0) addEntity('Item');

  const findEntity = (name) => {
    const key = singular(String(name)).toLowerCase();
    if (entityNames.has(key)) return entityNames.get(key);
    for (const [candidateKey, candidate] of entityNames) {
      if (candidateKey.startsWith(key) || key.startsWith(candidateKey)) return candidate;
    }
    return null;
  };

  const resources = [];
  const usedPaths = new Set();
  // Auth nodes get dedicated JWT routes, so they are not duplicated as CRUD resources.
  const resourceNodes = nodes.filter((node) => node.type === 'service');

  for (const node of resourceNodes) {
    const words = meaningfulWords(node.label);
    const base = words.length > 0 ? singular(toPascal(words.join(' '))) : 'Resource';
    let entity = findEntity(base);
    const assignedDatabase = databases.find((candidate) => connected(node.id, candidate.id))
      ?? nearestDatabase(node, { nodes, edges }, nodesById);

    if (!entity) {
      const database = assignedDatabase;
      const databaseEntities =
        database?.entities?.length
          ? database.entities.map((value) => findEntity(value)).filter(Boolean)
          : database
            ? meaningfulWords(database.label).map((value) => findEntity(value)).filter(Boolean)
            : [];
    entity = databaseEntities[0] ?? base;
    if (!entityNames.has(entity.toLowerCase())) {
      entityNames.set(entity.toLowerCase(), entity);
      entityOrder.push(entity);
    }
    if (assignedDatabase) entityDatabase.set(entity, assignedDatabase.id);
    }

    const path = toKebab(pluralize(base));
    if (usedPaths.has(path)) continue;
    usedPaths.add(path);
    resources.push({ name: base, model: entity, path, nodeId: node.id, databaseId: assignedDatabase?.id ?? entityDatabase.get(entity) ?? databases[0]?.id ?? null });
  }

  if (resources.length === 0 && resourceNodes.length === 0) {
    for (const entity of entityOrder) {
      resources.push({ name: entity, model: entity, path: toKebab(pluralize(entity)), nodeId: null, databaseId: entityDatabase.get(entity) ?? databases[0]?.id ?? null });
    }
  }

  return {
    entities: entityOrder,
    resources,
    hasAuth,
    databases: databases.map((node, index) => ({ id: node.id, key: toKebab(node.id), envKey: `DATABASE_${toPascal(node.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_URL`, label: node.label, engine: databaseEngines[index], entities: node.entities ?? [] })),
    entityDatabase: Object.fromEntries(entityDatabase),
    hasCache: nodes.some((node) => node.type === 'cache'),
    topology: edges.map((edge) => ({ from: nodesById.get(edge.from)?.label ?? edge.from, to: nodesById.get(edge.to)?.label ?? edge.to, kind: edge.kind, label: edge.label ?? '' })),
    stats: { nodes: nodes.length, edges: edges.length, services: resourceNodes.length, databases: databases.length },
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function backendPackageJson(boardName, hasAuth, databases, hasCache) {
  const deps = {
    cors: '^2.8.5',
    dotenv: '^16.4.7',
    express: '^4.21.2',
    ...databaseDependencies(databases, hasCache),
  };
  if (hasAuth) {
    deps.bcryptjs = '^2.4.3';
    deps.jsonwebtoken = '^9.0.2';
  }
  return JSON.stringify(
    {
      name: asciiSlug(boardName) + '-api',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { dev: 'node --watch src/server.js', start: 'node src/server.js' },
      dependencies: deps,
    },
    null,
    2,
  );
}

function frontendPackageJson(boardName) {
  return JSON.stringify(
    {
      name: asciiSlug(boardName) + '-web',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^6.0.7' },
    },
    null,
    2,
  );
}

function modelTemplate(entity, options) {
  return `export { list, getById, findByEmail, create, update, remove } from '../repositories/${options.table}.js';`;
}

function controllerTemplate(resource, hasCache = false) {
  const model = resource.model;
  const isUser = model === 'User';
  const fields = isUser ? "const { name, email, role } = req.body;" : "const { name, description, status } = req.body;";

  return [
    `import * as ${model} from '../models/${model}.js';`,
    ...(hasCache ? ["import { cacheGet, cacheSet, cacheDelete } from '../config/cache.js';"] : []),
    '',
    'export async function list(req, res, next) {',
    '  try {',
    "    const status = typeof req.query.status === 'string' ? req.query.status : undefined;",
    '    const filter = status ? { status } : {};',
    ...(hasCache ? [`    const cacheKey = '${resource.path}:list:' + (filter.status || 'all');`, '    const cached = await cacheGet(cacheKey);', '    if (cached) return res.json({ data: cached });', `    const records = await ${model}.list(filter);`, '    await cacheSet(cacheKey, records, 60);'] : [`    const records = await ${model}.list(filter);`]),
    '    res.json({ data: records });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '}',
    '',
    'export async function getById(req, res, next) {',
    '  try {',
    ...(hasCache ? [`    const cacheKey = '${resource.path}:item:' + req.params.id;`, '    const cached = await cacheGet(cacheKey);', '    if (cached) return res.json({ data: cached });', `    const record = await ${model}.getById(req.params.id);`] : [`    const record = await ${model}.getById(req.params.id);`]),
    "    if (!record) return res.status(404).json({ error: { message: 'Not found' } });",
    '    res.json({ data: record });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '}',
    '',
    'export async function create(req, res, next) {',
    '  try {',
    '    ' + fields,
    "    if (!name) return res.status(400).json({ error: { message: 'name is required' } });",
    isUser
      ? `    const record = await ${model}.create({ name, email, role });`
      : `    const record = await ${model}.create({ name, description, status });`,
    ...(hasCache ? [`    await cacheDelete('${resource.path}:list:*');`] : []),
    '    res.status(201).json({ data: record });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '}',
    '',
    'export async function update(req, res, next) {',
    '  try {',
    isUser
      ? "    const { name, email, role } = req.body;"
      : "    const { name, description, status } = req.body;",
    `    const record = await ${model}.update(req.params.id, ${isUser ? '{ name, email, role }' : '{ name, description, status }'});`,
    ...(hasCache ? [`    await cacheDelete('${resource.path}:item:' + req.params.id);`, `    await cacheDelete('${resource.path}:list:*');`] : []),
    "    if (!record) return res.status(404).json({ error: { message: 'Not found' } });",
    '    res.json({ data: record });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '}',
    '',
    'export async function remove(req, res, next) {',
    '  try {',
    `    const record = await ${model}.remove(req.params.id);`,
    ...(hasCache ? [`    await cacheDelete('${resource.path}:item:' + req.params.id);`, `    await cacheDelete('${resource.path}:list:*');`] : []),
    "    if (!record) return res.status(404).json({ error: { message: 'Not found' } });",
    '    res.status(204).end();',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '}',
  ].join('\n');
}

function routeTemplate(resource, hasAuth) {
  return [
    "import { Router } from 'express';",
    ...(hasAuth ? ["import { requireAuth } from '../middleware/auth.js';"] : []),
    `import * as controller from '../controllers/${resource.path}.controller.js';`,
    '',
    'const router = Router();',
    ...(hasAuth ? ['', 'router.use(requireAuth);'] : []),
    '',
    "router.route('/').get(controller.list).post(controller.create);",
    "router.route('/:id').get(controller.getById).patch(controller.update).delete(controller.remove);",
    '',
    'export default router;',
  ].join('\n');
}

function authTemplate() {
  return [
    "import { Router } from 'express';",
    "import bcrypt from 'bcryptjs';",
    "import jwt from 'jsonwebtoken';",
    "import { User } from '../models/User.js';",
    "import { requireAuth } from '../middleware/auth.js';",
    '',
    'const router = Router();',
    '',
    'function signToken(user) {',
    '  return jwt.sign(',
    "    { sub: String(user._id), role: user.role },",
    '    process.env.JWT_SECRET || \'change-me\',',
    "    { expiresIn: '15m' },",
    '  );',
    '}',
    '',
    'function signRefreshToken(user) {',
    '  return jwt.sign(',
    "    { sub: String(user._id), tokenUse: 'refresh' },",
    "    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me',",
    "    { expiresIn: '7d' },",
    '  );',
    '}',
    '',
    "router.post('/register', async (req, res, next) => {",
    '  try {',
    '    const { name, email, password } = req.body;',
    "    if (!name || !email || !password) return res.status(400).json({ error: { message: 'name, email and password are required' } });",
    '    if (String(password).length < 8) return res.status(400).json({ error: { message: \'Password must be at least 8 characters\' } });',
    '    const existing = await User.findByEmail(email);',
    "    if (existing) return res.status(409).json({ error: { message: 'Email already registered' } });",
    '    const passwordHash = await bcrypt.hash(password, 12);',
    '    const user = await User.create({ name, email, passwordHash });',
    '    res.status(201).json({',
    "      data: { user: { id: user._id, name: user.name, email: user.email, role: user.role }, accessToken: signToken(user), refreshToken: signRefreshToken(user) },",
    '    });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '});',
    '',
    "router.post('/login', async (req, res, next) => {",
    '  try {',
    '    const { email, password } = req.body;',
    "    const user = await User.findByEmail(email || '');",
    "    if (!user) return res.status(401).json({ error: { message: 'Invalid credentials' } });",
    '    const valid = await bcrypt.compare(String(password || \'\'), user.passwordHash);',
    "    if (!valid) return res.status(401).json({ error: { message: 'Invalid credentials' } });",
    '    res.json({ data: { user: { id: user._id, name: user.name, email: user.email, role: user.role }, accessToken: signToken(user), refreshToken: signRefreshToken(user) } });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '});',
    '',
    "router.post('/refresh', async (req, res, next) => {",
    '  try {',
    '    const token = req.body?.refreshToken;',
    "    if (!token) return res.status(401).json({ error: { message: 'Refresh token required' } });",
    "    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me');",
    "    if (payload.tokenUse !== 'refresh') return res.status(401).json({ error: { message: 'Invalid refresh token' } });",
    '    const user = await User.getById(payload.sub);',
    "    if (!user) return res.status(401).json({ error: { message: 'Invalid refresh token' } });",
    '    res.json({ data: { accessToken: signToken(user), refreshToken: signRefreshToken(user) } });',
    '  } catch (error) {',
    "    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(401).json({ error: { message: 'Invalid or expired refresh token' } });",
    '    next(error);',
    '  }',
    '});',
    '',
    "router.get('/me', requireAuth, async (req, res, next) => {",
    '  try {',
    '    const user = await User.getById(req.userId);',
    "    if (!user) return res.status(404).json({ error: { message: 'User not found' } });",
    '    res.json({ data: user });',
    '  } catch (error) {',
    '    next(error);',
    '  }',
    '});',
    '',
    'export default router;',
  ].join('\n');
}

function authMiddlewareTemplate() {
  return [
    "import jwt from 'jsonwebtoken';",
    '',
    'export function requireAuth(req, res, next) {',
    "  const header = req.headers.authorization || '';",
    "  const [scheme, token] = header.split(' ');",
    "  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: { message: 'Authentication required' } });",
    '  try {',
    "    const payload = jwt.verify(token, process.env.JWT_SECRET || 'change-me');",
    "    if (payload.tokenUse === 'refresh') return res.status(401).json({ error: { message: 'Access token required' } });",
    '    req.userId = payload.sub;',
    '    req.userRole = payload.role;',
    '    return next();',
    '  } catch {',
    "    return res.status(401).json({ error: { message: 'Invalid or expired token' } });",
    '  }',
    '}',
  ].join('\n');
}

function errorHandlerTemplate() {
  return [
    'export function notFound(req, res) {',
    '  res.status(404).json({ error: { message: `Route ${req.method} ${req.originalUrl} not found` } });',
    '}',
    '',
    '// eslint-disable-next-line no-unused-vars',
    'export function errorHandler(error, req, res, next) {',
    '  const status = error.status || error.statusCode || (error.name === \'ValidationError\' ? 400 : 500);',
    '  if (status >= 500) console.error(error);',
    '  res.status(status).json({',
    "    error: { message: error.message || 'Internal server error' },",
    '  });',
    '}',
  ].join('\n');
}

function appTemplate(resources, hasAuth) {
  const routeImports = resources
    .map((resource) => `import ${toCamel(resource.name)}Routes from './routes/${resource.path}.routes.js';`)
    .join('\n');
  const routeMounts = resources
    .map((resource) => `app.use('/api/${resource.path}', ${toCamel(resource.name)}Routes);`)
    .join('\n');

  return [
    "import express from 'express';",
    "import cors from 'cors';",
    ...(hasAuth ? ["import authRoutes from './routes/auth.routes.js';"] : []),
    routeImports,
    "import { errorHandler, notFound } from './middleware/errorHandler.js';",
    '',
    'const app = express();',
    '',
    'app.use(cors());',
    "app.use(express.json({ limit: '1mb' }));",
    '',
    "app.get('/api/health', (req, res) => {",
    "  res.json({ status: 'ok', uptime: process.uptime() });",
    '});',
    '',
    ...(hasAuth ? ["app.use('/api/auth', authRoutes);"] : []),
    routeMounts,
    '',
    'app.use(notFound);',
    'app.use(errorHandler);',
    '',
    'export default app;',
  ].join('\n');
}

function pageTemplate(resource) {
  const component = toPascal(resource.name) + 'Page';
  const model = resource.model;

  return [
    "import { useEffect, useState } from 'react';",
    "import { api } from '../api/client.js';",
    '',
    `const RESOURCE = '${resource.path}';`,
    '',
    `export default function ${component}() {`,
    '  const [items, setItems] = useState([]);',
    "  const [form, setForm] = useState({ name: '', description: '' });",
    "  const [error, setError] = useState('');",
    '  const [loading, setLoading] = useState(true);',
    '',
    '  async function load() {',
    '    try {',
    '      setLoading(true);',
    '      const payload = await api.list(RESOURCE);',
    '      setItems(payload.data ?? []);',
    "      setError('');",
    '    } catch (loadError) {',
    '      setError(loadError.message);',
    '    } finally {',
    '      setLoading(false);',
    '    }',
    '  }',
    '',
    '  useEffect(() => {',
    '    load();',
    '  }, []);',
    '',
    '  async function handleSubmit(event) {',
    '    event.preventDefault();',
    '    try {',
    '      await api.create(RESOURCE, form);',
    "      setForm({ name: '', description: '' });",
    '      await load();',
    '    } catch (submitError) {',
    '      setError(submitError.message);',
    '    }',
    '  }',
    '',
    '  async function handleDelete(id) {',
    '    try {',
    '      await api.remove(RESOURCE, id);',
    '      setItems((current) => current.filter((item) => item._id !== id));',
    '    } catch (deleteError) {',
    '      setError(deleteError.message);',
    '    }',
    '  }',
    '',
    '  return (',
    '    <section>',
    `      <h2>${component.replace('Page', '')}</h2>`,
    '      <p className="hint">Generated from the ArchFlow diagram (model: ' + model + ').</p>',
    '      <form className="card form" onSubmit={handleSubmit}>',
    '        <input',
    '          value={form.name}',
    "          onChange={(event) => setForm({ ...form, name: event.target.value })}",
    '          placeholder="Name"',
    '          required',
    '        />',
    '        <input',
    '          value={form.description}',
    "          onChange={(event) => setForm({ ...form, description: event.target.value })}",
    '          placeholder="Description"',
    '        />',
    '        <button type="submit">Create</button>',
    '      </form>',
    "      {error ? <p className=\"error\">{error}</p> : null}",
    "      {loading ? <p>Loading...</p> : null}",
    '      <ul className="list">',
    '        {items.map((item) => (',
    '          <li key={item._id} className="card">',
    '            <div>',
    '              <strong>{item.name}</strong>',
    '              <p>{item.description || item.email || \'No description\'}</p>',
    '            </div>',
    '            <button type="button" onClick={() => handleDelete(item._id)}>',
    '              Delete',
    '            </button>',
    '          </li>',
    '        ))}',
    '      </ul>',
    '    </section>',
    '  );',
    '}',
  ].join('\n');
}

function generatedAppTemplate(resources) {
  const imports = resources
    .map((resource) => `import ${toPascal(resource.name)}Page from './pages/${toPascal(resource.name)}Page.jsx';`)
    .join('\n');
  const entries = resources
    .map((resource) => `  { key: '${resource.path}', label: '${resource.name}', component: ${toPascal(resource.name)}Page },`)
    .join('\n');

  return [
    "import { useState } from 'react';",
    imports,
    '',
    'const PAGES = [',
    entries,
    '];',
    '',
    'export default function App() {',
    '  const [active, setActive] = useState(PAGES[0].key);',
    '  const ActivePage = PAGES.find((page) => page.key === active)?.component ?? PAGES[0].component;',
    '',
    '  return (',
    '    <div className="shell">',
    '      <header>',
    '        <h1>Generated ArchFlow App</h1>',
    '        <nav>',
    '          {PAGES.map((page) => (',
    '            <button',
    '              key={page.key}',
    '              type="button"',
    '              className={page.key === active ? \'active\' : undefined}',
    '              onClick={() => setActive(page.key)}',
    '            >',
    '              {page.label}',
    '            </button>',
    '          ))}',
    '        </nav>',
    '      </header>',
    '      <main>',
    '        <ActivePage />',
    '      </main>',
    '    </div>',
    '  );',
    '}',
  ].join('\n');
}

const BASE_CSS = `:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: #121a30;
  --border: #22304d;
  --text: #e6edf7;
  --muted: #94a3b8;
  --accent: #38bdf8;
  font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: radial-gradient(circle at top, #14213d, var(--bg) 60%);
  color: var(--text);
  min-height: 100vh;
}

.shell { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; margin-bottom: 28px; }
h1 { font-size: 22px; margin: 0; }
nav { display: flex; gap: 8px; flex-wrap: wrap; }
button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px; cursor: pointer; font: inherit; }
button:hover { border-color: var(--accent); }
nav button.active { background: #0f2740; border-color: var(--accent); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
.form { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0; }
input { flex: 1 1 200px; background: #0b1424; border: 1px solid var(--border); color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.list { list-style: none; padding: 0; display: grid; gap: 10px; }
.list li { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.list p { margin: 4px 0 0; color: var(--muted); }
.hint { color: var(--muted); font-size: 14px; }
.error { color: #f87171; }
`;

function rootReadme(boardName, interpretation) {
  const engineLabels = { mongodb: 'MongoDB', postgresql: 'PostgreSQL', mysql: 'MySQL', redis: 'Redis' };
  const selectedStores = [...new Set([
    ...interpretation.databases.map((database) => engineLabels[database.engine] ?? database.engine),
    ...(interpretation.hasCache ? ['Redis cache'] : []),
  ])];
  const endpointLines = interpretation.resources
    .map((resource) => `- \`/api/${resource.path}\` → ${resource.model} CRUD`)
    .join('\n');

  return [
    '# ' + boardName + ' — generated by ArchFlow',
    '',
    'This project was generated from the architecture diagram. Persistence and cache integrations follow the selected canvas nodes.',
    '',
    '## What was generated',
    '',
    ...interpretation.entities.map((entity) => `- Repository/model: \`${entity}\``),
    ...interpretation.databases.map((database) => `- ${database.engine} database: \`${database.label}\` via \`${database.envKey}\``),
    ...(interpretation.hasCache ? ['- Redis cache: `CACHE_REDIS_URL` (60 second list/item cache)'] : []),
    ...interpretation.resources.map((resource) => `- API route: \`/api/${resource.path}\``),
    interpretation.hasAuth ? '- JWT auth routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/auth/me`' : '',
    '',
    '## Run the backend',
    '',
    '```bash',
    'cd backend',
    'cp .env.example .env',
    'npm install',
    'npm run dev',
    '```',
    '',
    `Start ${selectedStores.join(' and ')} before running the API. The .env.example lists only the adapters selected on the canvas.`,
    'The API listens on `http://localhost:4000`. Health check: `GET /api/health`.',
    '',
    '## Run the frontend',
    '',
    '```bash',
    'cd frontend',
    'npm install',
    'npm run dev',
    '```',
    '',
    'The Vite dev server runs on `http://localhost:5173` and calls the API at `http://localhost:4000/api`',
    '(override with `VITE_API_URL`).',
    '',
    '## Endpoints',
    '',
    endpointLines,
    '',
    'Generated by [ArchFlow](https://github.com/). Review the schemas and add domain rules before shipping.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateProject({ boardName, graph }) {
  const interpretation = interpretGraph(graph);
  const unsupported = interpretation.databases.find((database) => !database.engine);
  if (unsupported) {
    const error = new Error(`Unsupported database component "${unsupported.label}". Generation stopped because no adapter is available. Supported database components: MongoDB, PostgreSQL, MySQL, and Redis.`);
    error.statusCode = 422;
    error.code = 'UNSUPPORTED_DATABASE';
    throw error;
  }
  const unsupportedCache = (graph?.nodes ?? []).find((node) => node.type === 'cache' && !/redis/i.test(`${node.label} ${node.description ?? ''}`));
  if (unsupportedCache) {
    const error = new Error(`Unsupported cache component "${unsupportedCache.label}". Generation stopped because no adapter is available. Supported cache component: Redis.`);
    error.statusCode = 422;
    error.code = 'UNSUPPORTED_CACHE';
    throw error;
  }
  const selectedDatabases = interpretation.databases.length
    ? interpretation.databases
    : [{ id: 'default', key: 'default', envKey: 'MONGO_URI', label: 'MongoDB (default)', engine: 'mongodb', entities: [] }];
  const cacheNodes = (graph?.nodes ?? []).filter((node) => node.type === 'cache');
  const hasCache = cacheNodes.length > 0;
  for (const resource of interpretation.resources) resource.databaseId ??= selectedDatabases[0].id;
  const files = createFileMap();
  const warnings = [];
  const safeBoardName = boardName || 'ArchFlow Project';

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const adjacent = (id) => edges.some((edge) => edge.from === id || edge.to === id);
  const reachable = (startId, targetType) => {
    const visited = new Set([startId]);
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      if (id !== startId && nodes.find((node) => node.id === id)?.type === targetType) return true;
      for (const edge of edges) {
        const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (next && !visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    return false;
  };
  const databaseNodes = nodes.filter((node) => node.type === 'database');
  const serviceNodes = nodes.filter((node) => node.type === 'service');
  if (databaseNodes.length === 0) {
    warnings.push('No database component was detected. A MongoDB starter store is included so the project runs; add and connect a database node to generate a stack-specific integration.');
  }
  if (!interpretation.hasAuth) {
    warnings.push('No auth component was on the canvas, so JWT auth routes were not generated.');
  }
  if (interpretation.stats.services === 0) {
    warnings.push('No service components were detected. Routes are inferred from declared data entities; add service nodes and connect them to the API entry point and their data stores for service-specific APIs.');
  }
  for (const service of serviceNodes.filter((node) => !adjacent(node.id))) {
    warnings.push(`${service.label} is disconnected. Connect it to an API entry point and the data stores it owns; its generated API is isolated from the depicted request flow.`);
  }
  for (const service of serviceNodes.filter((node) => databaseNodes.length > 0 && !reachable(node.id, 'database'))) {
    warnings.push(`${service.label} has no path to a database component. Connect the service to its data store so ownership and persistence are represented.`);
  }
  for (const database of databaseNodes.filter((node) => !adjacent(node.id))) {
    warnings.push(`${database.label} is disconnected. Connect a service or authentication component to generate a clear data ownership relationship.`);
  }
  const frontendNodes = nodes.filter((node) => node.type === 'frontend' || node.type === 'client');
  const apiNodes = nodes.filter((node) => ['gateway', 'service'].includes(node.type));
  if (frontendNodes.length && apiNodes.length && !edges.some((edge) =>
    (frontendNodes.some((node) => node.id === edge.from) && apiNodes.some((node) => node.id === edge.to)) ||
    (frontendNodes.some((node) => node.id === edge.to) && apiNodes.some((node) => node.id === edge.from)))) {
    warnings.push('No connection links the client or frontend to an API component. Add that edge so the request path is explicit.');
  }

  // Backend scaffold
  files.add('backend/package.json', backendPackageJson(safeBoardName, interpretation.hasAuth, selectedDatabases, hasCache));
  files.add(
    'backend/.env.example',
    [
      'PORT=4000',
      ...databaseEnvironment(selectedDatabases, hasCache),
      ...(interpretation.hasAuth ? ['JWT_SECRET=replace-with-a-long-random-value', 'JWT_REFRESH_SECRET=use-a-different-long-random-value'] : []),
    ].join('\n'),
  );
  const readmeArchitecture = { ...interpretation, databases: selectedDatabases, hasCache };
  files.add('backend/README.md', rootReadme(safeBoardName, readmeArchitecture));
  files.add(
    'backend/src/server.js',
    [
      "import 'dotenv/config';",
      "import app from './app.js';",
      "import { connectDatabases, closeDatabases } from './config/databases.js';",
      ...(hasCache ? ["import { connectCache, closeCache } from './config/cache.js';"] : []),
      '',
      'const port = Number(process.env.PORT) || 4000;',
      '',
      'async function start() {',
      '  await connectDatabases();',
      ...(hasCache ? ['  await connectCache();'] : []),
      '  app.listen(port, () => {',
      '    console.log(`API ready on http://localhost:${port}`);',
      '  });',
      '}',
      '',
      "process.on('SIGINT', async () => {",
      ...(hasCache ? ['  await closeCache();'] : []),
      '  await closeDatabases();',
      '  process.exit(0);',
      '});',
      '',
      'start().catch((error) => {',
      "  console.error('Failed to start API', error);",
      '  process.exit(1);',
      '});',
    ].join('\n'),
  );
  files.add('backend/src/config/databases.js', databaseConfigTemplate(selectedDatabases));
  if (hasCache) files.add('backend/src/config/cache.js', cacheConfigTemplate());
  files.add('backend/src/app.js', appTemplate(interpretation.resources, interpretation.hasAuth));
  files.add('backend/src/middleware/errorHandler.js', errorHandlerTemplate());
  if (interpretation.hasAuth) {
    files.add('backend/src/middleware/auth.js', authMiddlewareTemplate());
    files.add('backend/src/routes/auth.routes.js', authTemplate());
  }

  for (const entity of interpretation.entities) {
    const rawDatabaseId = interpretation.entityDatabase[entity] ?? interpretation.resources.find((resource) => resource.model === entity)?.databaseId ?? selectedDatabases[0].id;
    const database = selectedDatabases.find((candidate) => candidate.id === rawDatabaseId) ?? selectedDatabases[0];
    const table = toKebab(entity);
    const metadata = { entity, database, table };
    files.add(`backend/src/models/${entity}.js`, modelTemplate(entity, metadata));
    files.add(`backend/src/repositories/${table}.js`, repositoryTemplate(metadata));
  }
  for (const resource of interpretation.resources) {
    files.add(`backend/src/routes/${resource.path}.routes.js`, routeTemplate(resource, interpretation.hasAuth));
    files.add(`backend/src/controllers/${resource.path}.controller.js`, controllerTemplate(resource, hasCache));
  }

  // Frontend scaffold
  files.add('frontend/package.json', frontendPackageJson(safeBoardName));
  files.add(
    'frontend/vite.config.js',
    [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      'export default defineConfig({',
      '  plugins: [react()],',
      '  server: { port: 5173 },',
      '});',
    ].join('\n'),
  );
  files.add(
    'frontend/index.html',
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <title>' + safeBoardName + '</title>',
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.jsx"></script>',
      '  </body>',
      '</html>',
    ].join('\n'),
  );
  files.add(
    'frontend/src/main.jsx',
    [
      "import React from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import App from './App.jsx';",
      "import './index.css';",
      '',
      'createRoot(document.getElementById(\'root\')).render(',
      '  <React.StrictMode>',
      '    <App />',
      '  </React.StrictMode>,',
      ');',
    ].join('\n'),
  );
  files.add('frontend/src/App.jsx', generatedAppTemplate(interpretation.resources));
  files.add('frontend/src/index.css', BASE_CSS);
  files.add(
    'frontend/src/api/client.js',
    [
      "const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';",
      '',
      'async function request(path, options = {}) {',
      '  const response = await fetch(API_URL + path, {',
      "    headers: { 'Content-Type': 'application/json' },",
      '    ...options,',
      '  });',
      '  if (response.status === 204) return {};',
      '  const payload = await response.json().catch(() => ({}));',
      "  if (!response.ok) throw new Error(payload?.error?.message || 'Request failed');",
      '  return payload;',
      '}',
      '',
      'export const api = {',
      '  list: (resource) => request(\'/\' + resource),',
      "  create: (resource, body) => request('/' + resource, { method: 'POST', body: JSON.stringify(body) }),",
      "  remove: (resource, id) => request('/' + resource + '/' + id, { method: 'DELETE' }),",
      '};',
    ].join('\n'),
  );
  for (const resource of interpretation.resources) {
    files.add(`frontend/src/pages/${toPascal(resource.name)}Page.jsx`, pageTemplate(resource));
  }
  files.add('README.md', rootReadme(safeBoardName, readmeArchitecture));

  const allFiles = files.list();
  return {
    files: allFiles,
    summary: {
      boardName: safeBoardName,
      entities: interpretation.entities,
      resources: interpretation.resources.map(({ name, model, path }) => ({ name, model, path })),
      hasAuth: interpretation.hasAuth,
      fileCount: allFiles.length,
      warnings,
      stats: interpretation.stats,
      generatedAdapters: selectedDatabases.map(({ id, key, label, engine, envKey }) => ({ id, key, label, engine, envKey })),
      cache: hasCache ? { engine: 'redis', nodes: cacheNodes.map(({ id, label }) => ({ id, label })) } : null,
      architecture: {
        components: nodes.map(({ id, type, label, description, entities }) => ({ id, type, label, description: description ?? '', entities: entities ?? [] })),
        connections: interpretation.topology,
        databases: interpretation.databases,
      },
    },
  };
}

export async function generateZip({ boardName, graph }) {
  const { files, summary } = generateProject({ boardName, graph });
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, summary, filename: asciiSlug(boardName || 'archflow-project') + '.zip' };
}

export const __testing = { singular, pluralize, toPascal, toKebab, interpretGraph };
