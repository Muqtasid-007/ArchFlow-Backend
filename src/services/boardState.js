import { Board } from '../models/Board.js';
import { ApiError } from '../utils/ApiError.js';
import { LIMITS } from '../utils/constants.js';
import { logger } from '../config/logger.js';
import { getRedisClient } from '../config/redis.js';
import crypto from 'node:crypto';
import { retryUntilSuccess } from '../utils/retry.js';

const PERSIST_DEBOUNCE_MS = 600;
export const BOARD_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_REMEMBERED_OPS = 1000;
const BOARD_KEY_PREFIX = 'archflow:board:';
const LOCK_KEY_PREFIX = 'archflow:board-lock:';
const LOCK_TTL_MS = 10_000;
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1]
  then return redis.call("del", KEYS[1])
  else return 0
  end
`;

/**
 * Redis-backed working copy of each active board graph.
 *
 * Canvas mutations arrive at high frequency (dragging, live cursors). We apply
 * them to the shared graph, broadcast immediately, and debounce durability to
 * MongoDB. Redis locks provide one writer per board across API instances.
 */
const timers = new Map();
const dirtyBoards = new Set();

const cloneGraph = (graph) => ({
  nodes: (graph.nodes ?? []).map((node) => ({ ...node, entities: [...(node.entities ?? [])] })),
  edges: (graph.edges ?? []).map((edge) => ({ ...edge })),
});

const boardKey = (boardId) => `${BOARD_KEY_PREFIX}${String(boardId)}`;
const lockKey = (boardId) => `${LOCK_KEY_PREFIX}${String(boardId)}`;

function serializeState(state) {
  return JSON.stringify({
    graph: cloneGraph(state.graph),
    revision: state.revision,
    lastEditor: state.lastEditor,
    appliedOps: Object.fromEntries(state.appliedOps),
  });
}

function deserializeState(payload) {
  const parsed = JSON.parse(payload);
  return {
    graph: cloneGraph(parsed.graph ?? {}),
    revision: parsed.revision ?? 1,
    dirty: false,
    timer: null,
    lastEditor: parsed.lastEditor ?? null,
    lastSavedAt: new Date(),
    appliedOps: new Map(Object.entries(parsed.appliedOps ?? {}).map(([opId, revision]) => [opId, Number(revision)])),
  };
}

async function saveRedisState(state, boardId) {
  await getRedisClient().set(boardKey(boardId), serializeState(state), {
    EX: BOARD_KEY_TTL_SECONDS,
  });
}

function stateFromMongo(board) {
  return {
    graph: cloneGraph(board.graph ?? {}),
    revision: board.revision ?? 1,
    dirty: false,
    timer: null,
    lastEditor: null,
    lastSavedAt: new Date(),
    appliedOps: new Map(),
  };
}

async function readFreshCachedState(boardId) {
  const key = String(boardId);
  const redis = getRedisClient();
  // GETEX refreshes the expiry whenever an active board is read from Redis.
  const cached = await redis.getEx(boardKey(key), { EX: BOARD_KEY_TTL_SECONDS });
  if (!cached) return null;

  const cachedState = deserializeState(cached);
  const board = await Board.findById(key).select('graph revision').lean();
  // Redis can be ahead while a debounced save is pending. Replace it only when
  // Mongo confirms that it has a strictly newer revision.
  if (!board || (board.revision ?? 1) <= cachedState.revision) return cachedState;

  const freshState = stateFromMongo(board);
  await saveRedisState(freshState, key);
  return freshState;
}

export async function getBoardState(boardId) {
  const key = String(boardId);
  const cachedState = await readFreshCachedState(key);
  if (cachedState) return cachedState;

  const board = await Board.findById(key).select('graph revision').lean();
  if (!board) throw ApiError.notFound('Board not found');

  const state = stateFromMongo(board);
  await saveRedisState(state, key);
  return state;
}

export async function getBoardStateFromRedis(boardId) {
  return readFreshCachedState(boardId);
}

/**
 * Authoritative server-side application of a validated canvas operation.
 * @param {object} state cached board state
 * @param {import('zod').infer<typeof import('../validators/schemas.js').canvasOpSchema>} op
 * @param {string} actorId
 */
export function applyOp(state, op, actorId) {
  const { graph } = state;

  switch (op.type) {
    case 'node.create': {
      if (graph.nodes.length >= LIMITS.MAX_NODES) {
        throw ApiError.badRequest(`A board can contain at most ${LIMITS.MAX_NODES} components`);
      }
      if (graph.nodes.some((node) => node.id === op.node.id)) {
        throw ApiError.conflict('A component with that id already exists');
      }
      graph.nodes.push({ ...op.node, entities: [...(op.node.entities ?? [])] });
      break;
    }
    case 'node.update': {
      const node = graph.nodes.find((entry) => entry.id === op.nodeId);
      if (!node) throw ApiError.notFound('Component not found');
      Object.assign(node, op.patch);
      break;
    }
    case 'node.delete': {
      const index = graph.nodes.findIndex((entry) => entry.id === op.nodeId);
      if (index === -1) throw ApiError.notFound('Component not found');
      graph.nodes.splice(index, 1);
      // Removing a component must not leave dangling connections.
      state.graph.edges = graph.edges.filter((edge) => edge.from !== op.nodeId && edge.to !== op.nodeId);
      break;
    }
    case 'edge.create': {
      if (graph.edges.length >= LIMITS.MAX_EDGES) {
        throw ApiError.badRequest(`A board can contain at most ${LIMITS.MAX_EDGES} connections`);
      }
      if (graph.edges.some((edge) => edge.id === op.edge.id)) {
        throw ApiError.conflict('A connection with that id already exists');
      }
      const ids = new Set(graph.nodes.map((node) => node.id));
      if (!ids.has(op.edge.from) || !ids.has(op.edge.to)) {
        throw ApiError.badRequest('Both connection endpoints must exist on the board');
      }
      graph.edges.push({ ...op.edge });
      break;
    }
    case 'edge.update': {
      const edge = graph.edges.find((entry) => entry.id === op.edgeId);
      if (!edge) throw ApiError.notFound('Connection not found');
      if (op.patch.from || op.patch.to) {
        const ids = new Set(graph.nodes.map((node) => node.id));
        if (op.patch.from && !ids.has(op.patch.from)) throw ApiError.badRequest('Source component does not exist');
        if (op.patch.to && !ids.has(op.patch.to)) throw ApiError.badRequest('Target component does not exist');
      }
      Object.assign(edge, op.patch);
      break;
    }
    case 'edge.delete': {
      const index = graph.edges.findIndex((entry) => entry.id === op.edgeId);
      if (index === -1) throw ApiError.notFound('Connection not found');
      graph.edges.splice(index, 1);
      break;
    }
    default:
      throw ApiError.badRequest('Unsupported canvas operation');
  }

  state.revision += 1;
  state.dirty = true;
  state.lastEditor = actorId;
  return state;
}

export function getAppliedOp(state, opId) {
  return state.appliedOps.get(opId);
}

export function rememberAppliedOp(state, opId, revision) {
  state.appliedOps.set(opId, revision);
  if (state.appliedOps.size > MAX_REMEMBERED_OPS) {
    const oldestOpId = state.appliedOps.keys().next().value;
    state.appliedOps.delete(oldestOpId);
  }
}

export async function withBoardLock(boardId, task) {
  const redis = getRedisClient();
  const key = String(boardId);
  const token = crypto.randomUUID();
  const acquired = await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = async () => {
      try {
        const result = await redis.set(lockKey(key), token, { NX: true, PX: LOCK_TTL_MS });
        if (result === 'OK') {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= LOCK_TTL_MS) {
          reject(new Error(`Could not acquire board lock for ${key}`));
          return;
        }
        setTimeout(attempt, 25);
      } catch (error) {
        reject(error);
      }
    };
    attempt();
  });

  if (!acquired) throw new Error(`Could not acquire board lock for ${key}`);

  try {
    const state = await getBoardState(key);
    const result = await task(state);
    await saveRedisState(state, key);
    return result;
  } finally {
    await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey(key)], arguments: [token] });
  }
}

export function schedulePersist(boardId) {
  const key = String(boardId);
  dirtyBoards.add(key);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    persist(key).catch((error) => logger.error({ err: error, boardId: key }, 'Failed to persist board'));
  }, PERSIST_DEBOUNCE_MS);
  timers.set(key, timer);
  timer.unref?.();
}

export async function persist(boardId) {
  const key = String(boardId);
  if (!dirtyBoards.has(key)) return;
  await retryUntilSuccess(() => withBoardLock(key, async (state) => {
    // Recheck after acquiring the lock in case another save finished first.
    if (!dirtyBoards.has(key)) return;
    const graph = cloneGraph(state.graph);
    const revision = state.revision;
    const lastEditor = state.lastEditor;

    await Board.updateOne(
      { _id: key },
      {
        $set: {
          graph,
          revision,
          ...(lastEditor ? { lastEditedBy: lastEditor } : {}),
        },
      },
    );
    dirtyBoards.delete(key);
    state.lastSavedAt = new Date();
  }), {
    onFailure: (error, { attempt, delayMs }) => logger.error(
      { err: error, boardId: key, attempt, retryInMs: delayMs },
      'Failed to persist board; retrying',
    ),
  });
}

export async function flushBoard(boardId) {
  const key = String(boardId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  await persist(key);
}

export async function flushAllBoards() {
  await Promise.allSettled(
    [...dirtyBoards].map((key) => {
      clearTimeout(timers.get(key));
      timers.delete(key);
      return persist(key);
    }),
  );
}

export async function invalidateBoard(boardId) {
  const key = String(boardId);
  clearTimeout(timers.get(key));
  timers.delete(key);
  dirtyBoards.delete(key);
  await getRedisClient().del(boardKey(key));
}
