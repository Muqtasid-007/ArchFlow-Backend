import * as snapshotService from '../services/snapshotService.js';

export async function listSnapshots(req, res) {
  const snapshots = await snapshotService.listSnapshots(req.board._id);
  res.json({ snapshots });
}

export async function createSnapshot(req, res) {
  const snapshot = await snapshotService.createSnapshot(req.board._id, req.user._id, req.body);
  // The graph is already on the client; keep history payloads lightweight.
  const { graph, ...summary } = snapshot;
  res.status(201).json({ snapshot: summary });
}

export async function restoreSnapshot(req, res) {
  const result = await snapshotService.restoreSnapshot(
    req.board._id,
    req.params.snapshotId,
    req.user._id,
  );
  res.json(result);
}

export async function deleteSnapshot(req, res) {
  await snapshotService.deleteSnapshot(req.board._id, req.params.snapshotId, req.user._id);
  res.status(204).end();
}
