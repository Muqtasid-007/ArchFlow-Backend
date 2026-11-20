import { Router } from 'express';
import { loadBoard } from '../middleware/boardAccess.js';
import { validate } from '../middleware/validate.js';
import {
  commentRepliesSchema,
  commentThreadListSchema,
  createCommentSchema,
  replyCommentSchema,
} from '../validators/schemas.js';
import * as commentController from '../controllers/commentController.js';

const router = Router({ mergeParams: true });

// Board membership is required for every read and write; the service checks it again.
router.get('/', loadBoard, validate(commentThreadListSchema, 'query'), commentController.listThreads);
router.post('/', loadBoard, validate(createCommentSchema), commentController.createThread);
router.get(
  '/:threadId/replies',
  loadBoard,
  validate(commentRepliesSchema, 'query'),
  commentController.getReplies,
);
router.post(
  '/:threadId/replies',
  loadBoard,
  validate(replyCommentSchema),
  commentController.replyToThread,
);
router.patch('/:threadId/resolve', loadBoard, commentController.resolveThread);
router.patch('/:threadId/reopen', loadBoard, commentController.reopenThread);
router.delete('/:commentId', loadBoard, commentController.deleteComment);

export default router;
