import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { User } from '../models/User.js';
import { Board } from '../models/Board.js';
import { Snapshot } from '../models/Snapshot.js';
import { logger } from '../config/logger.js';

const DEMO_PASSWORD = 'Demo1234!';

const node = (id, type, label, x, y, extra = {}) => ({
  id,
  type,
  label,
  x,
  y,
  width: 208,
  height: 96,
  description: '',
  entities: [],
  ...extra,
});

const DEMO_GRAPH = {
  nodes: [
    node('client-web', 'client', 'Web Client', 40, 260, {
      description: 'React SPA used by merchants and their finance teams.',
    }),
    node('frontend-web', 'frontend', 'Merchant Dashboard', 40, 120, {
      description: 'React + Vite dashboard deployed to the CDN.',
    }),
    node('gateway', 'gateway', 'API Gateway', 320, 240, {
      description: 'TLS termination, rate limiting and routing.',
    }),
    node('auth', 'auth', 'Auth Service', 600, 60, {
      description: 'Issues short-lived JWTs and refreshes sessions.',
      entities: ['Users', 'Sessions'],
    }),
    node('payments', 'service', 'Payments Service', 600, 220, {
      description: 'Creates charges, refunds and payment intents.',
      entities: ['Payments', 'Refunds'],
    }),
    node('orders', 'service', 'Orders Service', 600, 380, {
      description: 'Owns the order lifecycle.',
      entities: ['Orders'],
    }),
    node('queue', 'queue', 'Event Queue', 600, 540, {
      description: 'Kafka topic for payment and order domain events.',
    }),
    node('worker', 'worker', 'Ledger Worker', 900, 540, {
      description: 'Projects events into the immutable ledger.',
    }),
    node('cache', 'cache', 'Redis Cache', 900, 60, {
      description: 'Session and idempotency key cache.',
    }),
    node('mongo', 'database', 'MongoDB Cluster', 900, 240, {
      description: 'Primary datastore for transactional documents.',
      entities: ['Users', 'Payments', 'Orders'],
    }),
    node('stripe', 'external', 'Stripe API', 1200, 540, {
      description: 'External payment processor.',
    }),
  ],
  edges: [
    { id: 'e-client-gateway', from: 'client-web', to: 'gateway', label: 'HTTPS', kind: 'sync', description: '' },
    { id: 'e-frontend-gateway', from: 'frontend-web', to: 'gateway', label: 'HTTPS', kind: 'sync', description: '' },
    { id: 'e-gateway-auth', from: 'gateway', to: 'auth', label: 'token check', kind: 'sync', description: '' },
    { id: 'e-gateway-payments', from: 'gateway', to: 'payments', label: '/payments', kind: 'sync', description: '' },
    { id: 'e-gateway-orders', from: 'gateway', to: 'orders', label: '/orders', kind: 'sync', description: '' },
    { id: 'e-auth-mongo', from: 'auth', to: 'mongo', label: 'sessions', kind: 'data', description: '' },
    { id: 'e-payments-mongo', from: 'payments', to: 'mongo', label: 'writes', kind: 'data', description: '' },
    { id: 'e-orders-mongo', from: 'orders', to: 'mongo', label: 'writes', kind: 'data', description: '' },
    { id: 'e-payments-queue', from: 'payments', to: 'queue', label: 'payment.captured', kind: 'async', description: '' },
    { id: 'e-queue-worker', from: 'queue', to: 'worker', label: 'consume', kind: 'async', description: '' },
    { id: 'e-worker-stripe', from: 'worker', to: 'stripe', label: 'settlement', kind: 'sync', description: '' },
    { id: 'e-orders-cache', from: 'orders', to: 'cache', label: 'idempotency keys', kind: 'data', description: '' },
  ],
};

async function ensureUser(name, email) {
  const existing = await User.findByEmail(email);
  if (existing) return existing;
  return User.create({ name, email, password: DEMO_PASSWORD });
}

async function main() {
  await connectDatabase();
  logger.info('Seeding ArchFlow demo data');

  const owner = await ensureUser('Ayesha Khan', 'demo@archflow.dev');
  const collaborator = await ensureUser('Dev Patel', 'team@archflow.dev');

  const previousBoards = await Board.find({ name: 'Payments Platform Redesign', owner: owner._id }).distinct('_id');
  if (previousBoards.length > 0) await Snapshot.deleteMany({ board: { $in: previousBoards } });
  await Board.deleteMany({ name: 'Payments Platform Redesign', owner: owner._id });

  const board = await Board.create({
    name: 'Payments Platform Redesign',
    description: 'Target architecture for the 2026 payments migration. Draft reviewed weekly.',
    owner: owner._id,
    members: [{ user: collaborator._id, role: 'editor' }],
    graph: DEMO_GRAPH,
    revision: 12,
    lastEditedBy: collaborator._id,
  });

  const completedBoard = await Board.create({
    name: 'Notification Pipeline',
    description: 'Event-driven email and push delivery. Approved for build.',
    owner: owner._id,
    members: [{ user: collaborator._id, role: 'viewer' }],
    graph: {
      nodes: [
        node('svc', 'service', 'Notification Service', 120, 200, { entities: ['Notifications'] }),
        node('queue', 'queue', 'SQS Queue', 460, 200),
        node('worker', 'worker', 'Email Worker', 800, 120),
        node('db', 'database', 'MongoDB', 460, 400, { entities: ['Notifications', 'Templates'] }),
        node('mail', 'external', 'SendGrid', 1120, 120),
      ],
      edges: [
        { id: 'n1', from: 'svc', to: 'queue', kind: 'async', label: 'notification.created', description: '' },
        { id: 'n2', from: 'queue', to: 'worker', kind: 'async', label: 'consume', description: '' },
        { id: 'n3', from: 'worker', to: 'mail', kind: 'sync', label: 'send', description: '' },
        { id: 'n4', from: 'svc', to: 'db', kind: 'data', label: 'templates', description: '' },
      ],
    },
    revision: 4,
  });

  await Snapshot.create({
    board: completedBoard._id,
    name: 'Approved baseline',
    kind: 'manual',
    graph: completedBoard.graph,
    revision: completedBoard.revision,
    nodeCount: completedBoard.graph.nodes.length,
    edgeCount: completedBoard.graph.edges.length,
    createdBy: owner._id,
  });

  logger.info(
    {
      boards: [board.name, completedBoard.name],
      accounts: [
        { email: 'demo@archflow.dev', password: DEMO_PASSWORD, role: 'owner/admin' },
        { email: 'team@archflow.dev', password: DEMO_PASSWORD, role: 'editor' },
      ],
    },
    'Seed complete',
  );

  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error({ err: error }, 'Seeding failed');
  await disconnectDatabase();
  process.exit(1);
});
