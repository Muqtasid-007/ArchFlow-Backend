export const NODE_TYPES = Object.freeze([
  'client',
  'frontend',
  'gateway',
  'service',
  'database',
  'cache',
  'queue',
  'auth',
  'storage',
  'worker',
  'external',
  'sticky',
]);

export const EDGE_KINDS = Object.freeze(['sync', 'async', 'data']);

export const ROLES = Object.freeze(['admin', 'editor', 'viewer']);

export const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, admin: 3 });

export const LIMITS = Object.freeze({
  MAX_NODES: 400,
  MAX_EDGES: 800,
  MAX_MEMBERS: 50,
  MAX_MANUAL_SNAPSHOTS_PER_BOARD: 50,
  MAX_SNAPSHOTS_PER_BOARD: 100,
  MAX_GENERATED_FILES: 120,
});

export const DEFAULT_NODE_SIZE = Object.freeze({ width: 208, height: 96 });
