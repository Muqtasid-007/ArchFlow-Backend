/**
 * Deterministic architecture reviewer.
 *
 * This runs on every analysis, with or without an LLM provider configured, so
 * the "Analyze Architecture" feature is never a stub: it applies real
 * system-design heuristics to the canvas graph and returns actionable findings.
 */

const SEVERITY_WEIGHT = { critical: 25, high: 15, medium: 8, low: 3 };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const labelOf = (node) => `"${node.label}"`;

function scoreToRating(score) {
  if (score >= 85) return 'solid';
  if (score >= 70) return 'reasonable';
  if (score >= 50) return 'needs-work';
  return 'at-risk';
}

/** Depth-first search for dependency cycles between service nodes. */
function findServiceCycles(services, edges) {
  const serviceIds = new Set(services.map((service) => service.id));
  const adjacency = new Map(services.map((service) => [service.id, []]));
  for (const edge of edges) {
    if (serviceIds.has(edge.from) && serviceIds.has(edge.to)) {
      adjacency.get(edge.from).push(edge.to);
    }
  }

  const state = new Map();
  const cycles = [];
  const stack = [];

  const visit = (id) => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === 'visiting') {
        const start = stack.indexOf(next);
        cycles.push(stack.slice(start));
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const service of services) {
    if (!state.has(service.id)) visit(service.id);
  }
  return cycles;
}

/**
 * @param {{nodes: object[], edges: object[]}} graph
 */
export function analyzeGraph(graph) {
  const nodes = graph?.nodes ?? [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (graph?.edges ?? []).filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to,
  );

  const findings = [];
  const addFinding = (key, severity, title, detail, recommendation, nodeIdsHit = [], edgeIdsHit = []) => {
    findings.push({
      id: key,
      severity,
      title,
      detail,
      recommendation,
      nodeIds: nodeIdsHit,
      edgeIds: edgeIdsHit,
    });
  };

  if (nodes.length === 0) {
    return {
      score: null,
      rating: 'empty',
      summary: 'This board is empty. Drop in a client, a service, and a database to get a meaningful review.',
      findings: [],
      stats: { nodes: 0, edges: 0, services: 0, databases: 0, queues: 0, caches: 0 },
    };
  }

  const byType = (type) => nodes.filter((node) => node.type === type);
  const services = byType('service');
  const databases = byType('database');
  const queues = byType('queue');
  const caches = byType('cache');
  const gateways = byType('gateway');
  const authProviders = byType('auth');
  const workers = byType('worker');
  const frontends = byType('frontend');
  const clients = byType('client');
  const edgeKind = (kind) => edges.filter((edge) => edge.kind === kind);

  // --- Data persistence -----------------------------------------------------
  if (databases.length === 0 && (services.length > 0 || authProviders.length > 0)) {
    addFinding(
      'no-database',
      'high',
      'No persistence layer',
      `${plural(services.length, 'service')} are on the board but nothing owns durable state.`,
      'Add a database component and connect the services that own data to it.',
      services.map((service) => service.id),
    );
  }

  // --- Direct data access from clients -------------------------------------
  const directToDatabase = edges.filter((edge) => {
    const source = nodes.find((node) => node.id === edge.from);
    const target = nodes.find((node) => node.id === edge.to);
    return (
      target?.type === 'database' &&
      ['client', 'frontend'].includes(source?.type)
    );
  });
  if (directToDatabase.length > 0) {
    addFinding(
      'direct-database-access',
      'critical',
      'Clients talk to the database directly',
      'Browser and mobile clients should never hold database credentials: it makes authorization unenforceable.',
      'Route data access through a service or BFF/API gateway that enforces authentication and validation.',
      directToDatabase.flatMap((edge) => [edge.from, edge.to]),
      directToDatabase.map((edge) => edge.id),
    );
  }

  // --- Service dependency cycles -------------------------------------------
  const cycles = findServiceCycles(services, edges);
  if (cycles.length > 0) {
    const cycleLabels = cycles[0].map((id) => labelOf(nodes.find((node) => node.id === id))).join(' → ');
    addFinding(
      'service-cycle',
      'high',
      'Circular service dependency',
      `These services depend on each other in a loop: ${cycleLabels}. Deployments and failures will cascade.`,
      'Break the loop with an event (queue) or extract the shared logic into its own service.',
      cycles[0],
    );
  }

  // --- Sync coupling -------------------------------------------------------
  const serviceToService = edges.filter((edge) => {
    const source = nodes.find((node) => node.id === edge.from);
    const target = nodes.find((node) => node.id === edge.to);
    return source?.type === 'service' && target?.type === 'service';
  });
  const syncServiceToService = serviceToService.filter((edge) => edge.kind === 'sync');
  if (syncServiceToService.length > 0 && queues.length === 0) {
    addFinding(
      'sync-service-calls',
      'medium',
      'Synchronous service-to-service calls',
      `${plural(syncServiceToService.length, 'request')} between services are synchronous and there is no message queue on the board.`,
      'Introduce a queue (Kafka, RabbitMQ, SQS) for work that can be retried or processed asynchronously.',
      [...new Set(syncServiceToService.flatMap((edge) => [edge.from, edge.to]))],
      syncServiceToService.map((edge) => edge.id),
    );
  }

  // --- Edge concerns -------------------------------------------------------
  if (services.length >= 2 && gateways.length === 0) {
    addFinding(
      'no-gateway',
      'medium',
      'No API gateway or load balancer',
      'Multiple services are exposed without a single entry point, so clients need to know every internal address.',
      'Add a gateway component to centralize routing, TLS, rate limiting and load balancing.',
    );
  }

  if (services.length > 0 && authProviders.length === 0) {
    addFinding(
      'no-auth',
      'medium',
      'No identity or auth provider',
      'No component on the board is responsible for authentication or issuing tokens.',
      'Add an auth service (or an external identity provider) in front of the business services.',
      services.map((service) => service.id),
    );
  }

  if (databases.length > 0 && caches.length === 0 && services.length >= 2) {
    addFinding(
      'no-cache',
      'low',
      'No caching layer',
      'Every read currently reaches the database, which is the first thing to saturate under load.',
      'Put Redis or an equivalent cache in front of hot read paths once you measure a real bottleneck.',
      databases.map((database) => database.id),
    );
  }

  if (workers.length > 0 && queues.length === 0) {
    addFinding(
      'worker-without-queue',
      'low',
      'Workers without a queue',
      'Background workers are present but nothing feeds them messages.',
      'Connect the workers to a queue and define retry and dead-letter behaviour.',
      workers.map((worker) => worker.id),
    );
  }

  // --- Graph hygiene -------------------------------------------------------
  const connectedIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const isolated = nodes.filter((node) => !connectedIds.has(node.id));
  const isolatedNonDb = isolated.filter((node) => node.type !== 'database');
  if (isolatedNonDb.length > 0 && nodes.length > 1) {
    addFinding(
      'isolated-components',
      'low',
      'Disconnected components',
      `${plural(isolatedNonDb.length, 'component')} on the canvas ${isolatedNonDb.length === 1 ? 'has' : 'have'} no connections: ${isolatedNonDb.map(labelOf).join(', ')}.`,
      'Connect them to show how traffic reaches them, or remove them if they are leftovers.',
      isolatedNonDb.map((node) => node.id),
    );
  }

  if (databases.length > 0 && databases.every((database) => !connectedIds.has(database.id))) {
    addFinding(
      'unconnected-database',
      'high',
      'Database is not connected to anything',
      'A database that no service can reach is either a placeholder or a missing integration.',
      'Draw the connection from the service that owns this data to the database.',
      databases.map((database) => database.id),
    );
  }

  // --- Naming collisions ---------------------------------------------------
  const seenLabels = new Map();
  const duplicates = [];
  for (const node of nodes) {
    const key = node.label.trim().toLowerCase();
    if (seenLabels.has(key)) {
      duplicates.push(node.id, seenLabels.get(key));
    } else {
      seenLabels.set(key, node.id);
    }
  }
  if (duplicates.length > 0) {
    addFinding(
      'duplicate-labels',
      'low',
      'Duplicate component names',
      'Several components share the same label, which makes the diagram ambiguous during reviews.',
      'Give each component a unique, role-specific name.',
      [...new Set(duplicates)],
    );
  }

  // --- Scoring -------------------------------------------------------------
  const penalty = findings.reduce((total, finding) => total + SEVERITY_WEIGHT[finding.severity], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const strengths = [];
  if (databases.length > 0) strengths.push('a persistence layer');
  if (queues.length > 0) strengths.push('asynchronous messaging');
  if (authProviders.length > 0) strengths.push('authentication');
  if (gateways.length > 0) strengths.push('a centralized entry point');
  if (caches.length > 0) strengths.push('caching');

  const summaryParts = [
    `${plural(nodes.length, 'component')} and ${plural(edges.length, 'connection')} on the board.`,
    score >= 85
      ? 'The architecture covers the fundamentals well.'
      : score >= 70
        ? 'The architecture is reasonable but has gaps worth closing before implementation.'
        : 'The architecture is missing several foundational pieces.',
  ];
  if (strengths.length > 0) summaryParts.push(`It already has ${strengths.join(', ')}.`);
  if (findings.length > 0) summaryParts.push(`Top concern: ${findings[0].title.toLowerCase()}.`);

  return {
    score,
    rating: scoreToRating(score),
    summary: summaryParts.join(' '),
    findings,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      services: services.length,
      databases: databases.length,
      queues: queues.length,
      caches: caches.length,
    },
  };
}

export const __testing = { findServiceCycles, scoreToRating, SEVERITY_RANK };
