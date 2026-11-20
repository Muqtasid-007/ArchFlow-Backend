import * as Y from 'yjs';
import { Board } from '../models/Board.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { getBoardStateFromRedis } from './boardState.js';
import { retryUntilSuccess } from '../utils/retry.js';

const PERSIST_DELAY_MS = 600;
export const MAX_STICKY_UPDATE_BYTES = 100 * 1024;
export const MAX_STORED_STICKY_UPDATE_BYTES = 500 * 1024;
const docs = new Map();
const timers = new Map();
// A Y.Doc is dirty from its first unsaved update until Mongo confirms its save.
const dirtyDocs = new Set();
const docVersions = new Map();

export function normalizeStickyUpdate(payload) {
  let update;
  if (payload instanceof ArrayBuffer) {
    update = new Uint8Array(payload);
  } else if (payload instanceof Uint8Array) {
    update = payload;
  } else {
    throw ApiError.badRequest('Sticky update must be binary data');
  }
  if (update.byteLength > MAX_STICKY_UPDATE_BYTES) {
    throw ApiError.badRequest('Sticky update exceeds 100 KB');
  }
  return update;
}

export function normalizeStoredStickyUpdate(payload) {
  // Mongoose may expose a binary snapshot as base64 when it is converted to JSON.
  if (typeof payload === 'string') payload = Buffer.from(payload, 'base64');
  // Redis JSON serialization turns Node Buffers into { type, data } objects.
  if (payload?.type === 'Buffer' && Array.isArray(payload.data)) {
    payload = Uint8Array.from(payload.data);
  }
  // BSON Binary values may also survive snapshot restoration as an object.
  if (payload?._bsontype === 'Binary' && payload.buffer instanceof Uint8Array) {
    payload = payload.buffer.subarray(0, payload.position ?? payload.buffer.byteLength);
  }
  // Mongo's Buffer values are Uint8Arrays too, so this accepts the stored form.
  if (!(payload instanceof Uint8Array)) {
    throw ApiError.badRequest('Stored sticky update is not binary data');
  }
  if (payload.byteLength > MAX_STORED_STICKY_UPDATE_BYTES) {
    throw ApiError.badRequest('Stored sticky update exceeds 500 KB');
  }
  return payload;
}

function key(boardId, nodeId) {
  return `${String(boardId)}:${String(nodeId)}`;
}

export function stickyRoom(boardId, nodeId) {
  return `sticky:${String(boardId)}:${String(nodeId)}`;
}

export async function findStickyNodeWithSources({
  liveLookup,
  mongoLookup,
  boardId,
  nodeId,
}) {
  if (liveLookup) {
    try {
      const liveNode = await liveLookup();
      if (liveNode?.type === 'sticky' && liveNode.id === nodeId) {
        console.log('[sticky] Found in Redis/live state', { boardId, nodeId });
        return liveNode;
      }
    } catch (error) {
      console.log('[sticky] Redis/live lookup failed', {
        boardId,
        nodeId,
        error: error.message,
      });
    }
  }

  if (mongoLookup) {
    try {
      const mongoNode = await mongoLookup();
      if (mongoNode?.type === 'sticky' && mongoNode.id === nodeId) {
        console.log('[sticky] Found in MongoDB', { boardId, nodeId });
        return mongoNode;
      }
    } catch (error) {
      console.log('[sticky] MongoDB lookup failed', {
        boardId,
        nodeId,
        error: error.message,
      });
    }
  }

  console.log('[sticky] Not found in Redis or MongoDB', { boardId, nodeId });
  throw ApiError.notFound('Sticky note not found');
}

async function findStickyNode(boardId, nodeId) {
  const liveLookup = async () => {
    const liveState = await getBoardStateFromRedis(boardId);
    if (!liveState) return null;
    return (liveState.graph?.nodes ?? []).find(
      (entry) => entry.id === nodeId && entry.type === 'sticky',
    );
  };

  const mongoLookup = async () => {
    const board = await Board.findById(boardId).select('graph.nodes').lean();
    if (!board) return null;
    return (board.graph?.nodes ?? []).find(
      (entry) => entry.id === nodeId && entry.type === 'sticky',
    );
  };

  return findStickyNodeWithSources({
    liveLookup,
    mongoLookup,
    boardId,
    nodeId,
  });
}

export async function getStickyDoc(boardId, nodeId) {
  const id = key(boardId, nodeId);
  const cached = docs.get(id);
  if (cached) return cached;

  const node = await findStickyNode(boardId, nodeId);
  const doc = new Y.Doc();

  if (node.stickyUpdate) {
    const storedUpdate = normalizeStoredStickyUpdate(node.stickyUpdate);
    try {
      Y.applyUpdate(doc, storedUpdate);
    } catch {
      throw ApiError.badRequest('Stored sticky update is invalid');
    }
  }
  if (!doc.getText('text')) doc.getText('text');

  docs.set(id, doc);
  console.log('[sticky] Loaded Y.Doc', { boardId, nodeId });
  return doc;
}

/** Stop pending persistence and forget a sticky note that was deleted. */
export function removeStickyDoc(boardId, nodeId) {
  const id = key(boardId, nodeId);
  clearTimeout(timers.get(id));
  timers.delete(id);
  docs.delete(id);
  dirtyDocs.delete(id);
  docVersions.delete(id);
}

/** Forget every cached sticky document for a board after its graph is restored. */
export function clearStickyDocsForBoard(boardId) {
  const prefix = `${String(boardId)}:`;
  for (const id of docs.keys()) {
    if (!id.startsWith(prefix)) continue;

    // Stop delayed saves before dropping the old Y.Doc from memory.
    clearTimeout(timers.get(id));
    timers.delete(id);
    docs.get(id)?.destroy();
    docs.delete(id);
    dirtyDocs.delete(id);
    docVersions.delete(id);
  }
}

export async function applyStickyUpdate(boardId, nodeId, update) {
  const id = key(boardId, nodeId);
  await findStickyNode(boardId, nodeId);
  const doc = await getStickyDoc(boardId, nodeId);

  try {
    Y.applyUpdate(doc, update);
  } catch (error) {
    logger.warn({ err: error, boardId, nodeId }, 'Invalid Yjs sticky update');
    throw ApiError.badRequest('Invalid Yjs binary update');
  }
  console.log('[sticky] Applied binary update', {
    boardId,
    nodeId,
    bytes: update.byteLength,
  });

  clearTimeout(timers.get(id));
  dirtyDocs.add(id);
  docVersions.set(id, (docVersions.get(id) ?? 0) + 1);
  const timer = setTimeout(() => {
    persistStickyDoc(boardId, nodeId).catch((error) =>
      logger.error({ err: error, boardId, nodeId }, 'Failed to persist sticky note'),
    );
  }, PERSIST_DELAY_MS);
  timer.unref?.();
  timers.set(id, timer);
  return Y.encodeStateAsUpdate(doc);
}

export async function persistStickyDoc(boardId, nodeId) {
  const id = key(boardId, nodeId);
  clearTimeout(timers.get(id));
  timers.delete(id);

  const doc = docs.get(id);
  if (!doc || !dirtyDocs.has(id)) return;

  let binary;
  const savedVersion = docVersions.get(id);
  await retryUntilSuccess(async () => {
    // Re-encode on every attempt so updates made during a retry are included.
    binary = Buffer.from(Y.encodeStateAsUpdate(doc));
    await Board.updateOne(
      { _id: boardId, 'graph.nodes.id': nodeId, 'graph.nodes.type': 'sticky' },
      { $set: { 'graph.nodes.$.stickyUpdate': binary } },
    );
  }, {
    onFailure: (error, { attempt, delayMs }) => logger.error(
      { err: error, boardId, nodeId, attempt, retryInMs: delayMs },
      'Failed to persist sticky note; retrying',
    ),
  });
  // An edit can arrive while Mongo is writing. Keep it dirty for the next save.
  if (docVersions.get(id) === savedVersion) dirtyDocs.delete(id);
  else if (!timers.has(id)) {
    const timer = setTimeout(() => {
      persistStickyDoc(boardId, nodeId).catch((error) =>
        logger.error({ err: error, boardId, nodeId }, 'Failed to persist sticky note'),
      );
    }, PERSIST_DELAY_MS);
    timer.unref?.();
    timers.set(id, timer);
  }
  console.log('[sticky] Saved Y.Doc binary to MongoDB', {
    boardId,
    nodeId,
    bytes: binary.length,
  });
}

export async function flushStickyDocs(boardId) {
  const prefix = boardId === undefined ? null : `${String(boardId)}:`;
  const ids = [...docs.keys()].filter((id) => !prefix || id.startsWith(prefix));
  await Promise.allSettled(
    ids.map(async (id) => {
      const separator = id.indexOf(':');
      const boardId = id.slice(0, separator);
      const nodeId = id.slice(separator + 1);
      await persistStickyDoc(boardId, nodeId);
    }),
  );
}
