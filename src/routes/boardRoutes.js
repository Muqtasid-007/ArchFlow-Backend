import { Router } from 'express';
import { loadBoard, requireBoardRole } from '../middleware/boardAccess.js';
import { validate } from '../middleware/validate.js';
import { aiLimiter } from '../middleware/rateLimit.js';
import {
  createBoardSchema,
  inviteMemberSchema,
  updateBoardSchema,
  updateMemberSchema,
} from '../validators/schemas.js';
import * as boardController from '../controllers/boardController.js';
import * as aiController from '../controllers/aiController.js';
import * as generationController from '../controllers/generationController.js';
import snapshotRoutes from './snapshotRoutes.js';
import commentRoutes from './commentRoutes.js';

const router = Router();

router.get('/', boardController.listBoards);
router.post('/', validate(createBoardSchema), boardController.createBoard);

router.get('/:boardId', boardController.getBoard);
router.patch('/:boardId', loadBoard, requireBoardRole('admin'), validate(updateBoardSchema), boardController.updateBoard);
router.delete('/:boardId', loadBoard, requireBoardRole('admin'), boardController.deleteBoard);

router.get('/:boardId/members', loadBoard, boardController.listMembers);
router.post(
  '/:boardId/members',
  loadBoard,
  requireBoardRole('admin'),
  validate(inviteMemberSchema),
  boardController.addMember,
);
router.patch(
  '/:boardId/members/:userId',
  loadBoard,
  requireBoardRole('admin'),
  validate(updateMemberSchema),
  boardController.updateMemberRole,
);
router.delete('/:boardId/members/:userId', loadBoard, boardController.removeMember);

router.post('/:boardId/ai/analyze', loadBoard, aiLimiter, aiController.analyzeBoard);

router.post('/:boardId/generate', loadBoard, generationController.previewGeneration);
router.post('/:boardId/generate/download', loadBoard, generationController.downloadGeneration);

router.use('/:boardId/snapshots', snapshotRoutes);
router.use('/:boardId/comments', commentRoutes);

export default router;
