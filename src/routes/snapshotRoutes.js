import { Router } from 'express';
import { loadBoard, requireBoardRole } from '../middleware/boardAccess.js';
import { validate } from '../middleware/validate.js';
import { createSnapshotSchema } from '../validators/schemas.js';
import * as snapshotController from '../controllers/snapshotController.js';

const router = Router({ mergeParams: true });

router.get('/', loadBoard, requireBoardRole('viewer'), snapshotController.listSnapshots);
router.post(
  '/',
  loadBoard,
  requireBoardRole('editor'),
  validate(createSnapshotSchema),
  snapshotController.createSnapshot,
);
router.post(
  '/:snapshotId/restore',
  loadBoard,
  requireBoardRole('editor'),
  snapshotController.restoreSnapshot,
);
router.delete('/:snapshotId', loadBoard, requireBoardRole('editor'), snapshotController.deleteSnapshot);

export default router;
