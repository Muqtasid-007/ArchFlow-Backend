import crypto from 'node:crypto';
import { Snapshot } from '../models/Snapshot.js';
import { Board } from '../models/Board.js';
import { ApiError } from '../utils/ApiError.js';
import { LIMITS } from '../utils/constants.js';
import { publishBoardEvent } from './boardEvents.js';
import { withBoardLock } from './boardState.js';
import { loadFreshGraph } from './boardService.js';
import { clearStickyDocsForBoard } from './stickyNoteService.js';

export const MAX_SNAPSHOT_GRAPH_BYTES = 8 * 1024 * 1024;

export function assertManualSnapshotLimit(manualCount) {
  if (manualCount >= LIMITS.MAX_MANUAL_SNAPSHOTS_PER_BOARD) {
    throw ApiError.badRequest(
      `A board can have at most ${LIMITS.MAX_MANUAL_SNAPSHOTS_PER_BOARD} manual snapshots`,
    );
  }
}

// Manual history is preserved; only automatic entries are trimmed to fit the cap.
export function automaticSnapshotExcess(manualCount, automaticCount) {
  const availableAutomaticSlots = Math.max(
    0,
    LIMITS.MAX_SNAPSHOTS_PER_BOARD - manualCount,
  );
  return Math.max(0, automaticCount - availableAutomaticSlots);
}

function canonicalize(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'Buffer', data: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value.toObject === 'function') return canonicalize(value.toObject());
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function serializeGraph(graph) {
  return JSON.stringify(canonicalize(graph ?? {}));
}

export function hashGraph(graph) {
  return crypto.createHash('sha256').update(serializeGraph(graph)).digest('hex');
}

async function createSnapshotRecord(board, userId, { name, kind }) {
  const snapshotKind = kind ?? 'manual';
  const serializedGraph = serializeGraph(board.graph);
  const graphBytes = Buffer.byteLength(serializedGraph, 'utf8');
  if (graphBytes > MAX_SNAPSHOT_GRAPH_BYTES) {
    throw ApiError.badRequest('Snapshot graph exceeds the 8 MB size limit');
  }
  const graphHash = crypto.createHash('sha256').update(serializedGraph).digest('hex');
  const latestSnapshot = await Snapshot.findOne({ board: board._id }).sort({ createdAt: -1 });
  if (latestSnapshot) {
    // Hash older records on demand so existing history can also suppress duplicates.
    const latestHash = latestSnapshot.graphHash ?? hashGraph(latestSnapshot.graph);
    if (!latestSnapshot.graphHash) {
      latestSnapshot.graphHash = latestHash;
      await latestSnapshot.save();
    }
    if (latestHash === graphHash) return latestSnapshot.populate('createdBy', 'name email avatarColor');
  }

  if (snapshotKind === 'manual') {
    const manualCount = await Snapshot.countDocuments({ board: board._id, kind: 'manual' });
    assertManualSnapshotLimit(manualCount);
  }

  const snapshot = await Snapshot.create({
    board: board._id,
    name: name?.trim() || `Snapshot · ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
    kind: snapshotKind,
    graph: board.graph,
    graphHash,
    revision: board.revision,
    nodeCount: board.graph?.nodes?.length ?? 0,
    edgeCount: board.graph?.edges?.length ?? 0,
    createdBy: userId,
  });

  // Keep manual snapshots and remove only the oldest excess automatic entries.
  // Read kinds and count in JavaScript: Mongo/Mongoose can miscast operator
  // filters on this enum field in some supported versions.
  const existingSnapshots = await Snapshot.find({ board: board._id })
    .select('_id kind createdAt')
    .sort({ createdAt: 1 })
    .lean();
  const manualCount = existingSnapshots.filter((entry) => entry.kind === 'manual').length;
  const automaticCount = existingSnapshots.length - manualCount;
  const excessCount = automaticSnapshotExcess(manualCount, automaticCount);
  if (excessCount > 0) {
    const excess = existingSnapshots
      .filter((entry) => entry.kind !== 'manual')
      .slice(0, excessCount);
    if (excess.length > 0) {
      await Snapshot.deleteMany({ _id: { $in: excess.map((doc) => doc._id) } });
    }
  }

  return snapshot.populate('createdBy', 'name email avatarColor');
}

export async function createSnapshot(boardId, userId, options) {
  const board = await loadFreshGraph(boardId);
  const snapshot = await createSnapshotRecord(board, userId, options);
  return snapshot.toJSON();
}

export async function listSnapshots(boardId) {
  const snapshots = await Snapshot.find({ board: boardId })
    .select('-graph')
    .sort({ createdAt: -1 })
    .limit(LIMITS.MAX_SNAPSHOTS_PER_BOARD)
    .populate('createdBy', 'name email avatarColor')
    .lean();

  return snapshots.map((snapshot) => ({
    id: String(snapshot._id),
    name: snapshot.name,
    kind: snapshot.kind,
    revision: snapshot.revision,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount,
    createdBy: snapshot.createdBy,
    createdAt: snapshot.createdAt,
  }));
}

export async function restoreSnapshot(boardId, snapshotId, userId) {
  const snapshot = await Snapshot.findOne({ _id: snapshotId, board: boardId });
  if (!snapshot) throw ApiError.notFound('Snapshot not found');

  // The lock keeps restore ordered with canvas edits on this board. The locked
  // Redis state is also the freshest graph, including edits not yet in Mongo.
  const restored = await withBoardLock(boardId, async (state) => {
    // Preserve the current state before overwriting it so a restore is undoable.
    await createSnapshotRecord({
      _id: boardId,
      graph: state.graph,
      revision: state.revision,
    }, userId, { kind: 'auto', name: 'Auto-saved before restore' });

    const nextRevision = state.revision + 1;
    const graph = {
      nodes: (snapshot.graph?.nodes ?? []).map((node) => ({
        ...(typeof node.toObject === 'function' ? node.toObject() : node),
        entities: [...(node.entities ?? [])],
      })),
      edges: (snapshot.graph?.edges ?? []).map((edge) => (
        typeof edge.toObject === 'function' ? edge.toObject() : edge
      )),
    };

    // Mongo is written while the board lock is held. withBoardLock then writes
    // this same graph and revision to Redis before releasing the lock.
    await Board.updateOne(
      { _id: boardId },
      { $set: { graph, revision: nextRevision, lastEditedBy: userId } },
    );
    state.graph = graph;
    state.revision = nextRevision;
    state.lastEditor = String(userId);
    state.dirty = false;
    clearStickyDocsForBoard(boardId);
    return { graph, revision: nextRevision };
  });
  const { graph, revision: nextRevision } = restored;

  await publishBoardEvent('board:replaced', {
    boardId: String(boardId),
    graph,
    revision: nextRevision,
    restoredBy: String(userId),
    snapshotName: snapshot.name,
  });
  // Mounted sticky notes need a fresh Y.Doc after their server-side cache is cleared.
  await publishBoardEvent('sticky:resync', { boardId: String(boardId) });

  return { graph, revision: nextRevision, sourceSnapshot: snapshot.name };
}

export async function deleteSnapshot(boardId, snapshotId, userId) {
  const snapshot = await Snapshot.findOne({ _id: snapshotId, board: boardId });
  if (!snapshot) throw ApiError.notFound('Snapshot not found');
  if (String(snapshot.createdBy) !== String(userId)) {
    throw ApiError.forbidden('Only the person who created a snapshot can delete it');
  }
  await Snapshot.deleteOne({ _id: snapshot._id });
}
