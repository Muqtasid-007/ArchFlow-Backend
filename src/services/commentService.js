import mongoose from 'mongoose';
import { Board } from '../models/Board.js';
import { Comment } from '../models/Comment.js';
import { ApiError } from '../utils/ApiError.js';
import { ROLE_RANK } from '../utils/constants.js';
import { roleOfLean } from './boardService.js';
import { getBoardState } from './boardState.js';

const THREAD_PAGE_SIZE_MAX = 100;
const REPLY_PAGE_SIZE = 50;

async function getBoardRole(boardId, userId) {
  if (!mongoose.isValidObjectId(boardId)) throw ApiError.notFound('Board not found');
  const board = await Board.findById(boardId).select('owner members').lean();
  if (!board) throw ApiError.notFound('Board not found');
  const role = roleOfLean(board, userId);
  if (!role) throw ApiError.forbidden('You are not a member of this board');
  return role;
}

async function findRoot(boardId, threadId) {
  if (!mongoose.isValidObjectId(threadId)) throw ApiError.notFound('Comment thread not found');
  const root = await Comment.findOne({
    _id: threadId,
    boardId,
    threadId,
    parentId: null,
  });
  if (!root) throw ApiError.notFound('Comment thread not found');
  return root;
}

async function updateAnchorStatus(boardId, roots) {
  const state = await getBoardState(boardId);
  const nodes = new Map((state.graph.nodes ?? []).map((node) => [node.id, node]));
  await Promise.all(roots.map(async (root) => {
    if (root.anchor?.type !== 'node') return;
    const node = nodes.get(root.anchor.nodeId);
    if (!node) {
      if (!root.orphanedAt) {
        root.orphanedAt = new Date();
        await root.save();
      }
      return;
    }

    const lastWorldX = node.x + root.anchor.offsetX;
    const lastWorldY = node.y + root.anchor.offsetY;
    const changed = root.orphanedAt
      || root.lastWorldX !== lastWorldX
      || root.lastWorldY !== lastWorldY;
    root.orphanedAt = null;
    root.lastWorldX = lastWorldX;
    root.lastWorldY = lastWorldY;
    if (changed) await root.save();
  }));
}

export async function listThreads(boardId, userId, { state: threadState = 'open', cursor, limit = 50 } = {}) {
  await getBoardRole(boardId, userId);
  const pageSize = Math.min(THREAD_PAGE_SIZE_MAX, Math.max(1, Number(limit) || 50));
  const filter = {
    boardId,
    parentId: null,
    deletedAt: null,
    resolved: threadState === 'resolved',
  };
  if (cursor) {
    if (!mongoose.isValidObjectId(cursor)) throw ApiError.badRequest('Invalid thread cursor');
    filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
  }

  const roots = await Comment.find(filter)
    .sort({ _id: -1 })
    .limit(pageSize + 1)
    .populate('authorId', 'name avatarColor')
    .populate('resolvedBy', 'name avatarColor');
  const hasMore = roots.length > pageSize;
  roots.length = Math.min(roots.length, pageSize);
  await updateAnchorStatus(boardId, roots);

  const threadIds = roots.map((root) => root._id);
  const counts = threadIds.length
    ? await Comment.aggregate([
      { $match: { boardId: new mongoose.Types.ObjectId(boardId), threadId: { $in: threadIds }, parentId: { $ne: null }, deletedAt: null } },
      { $group: { _id: '$threadId', count: { $sum: 1 } } },
    ])
    : [];
  const countByThread = new Map(counts.map(({ _id, count }) => [String(_id), count]));
  return {
    threads: roots.map((root) => ({
      ...root.toJSON(),
      replyCount: countByThread.get(String(root._id)) ?? 0,
      orphaned: Boolean(root.orphanedAt),
    })),
    nextCursor: hasMore ? String(roots.at(-1)._id) : null,
  };
}

export async function getReplies(boardId, threadId, userId, cursor) {
  await getBoardRole(boardId, userId);
  const root = await findRoot(boardId, threadId);
  const filter = { boardId, threadId: root._id, parentId: root._id, deletedAt: null };
  if (cursor) {
    if (!mongoose.isValidObjectId(cursor)) throw ApiError.badRequest('Invalid reply cursor');
    filter._id = { $gt: new mongoose.Types.ObjectId(cursor) };
  }
  const replies = await Comment.find(filter)
    .sort({ _id: 1 })
    .limit(REPLY_PAGE_SIZE + 1)
    .populate('authorId', 'name avatarColor');
  const hasMore = replies.length > REPLY_PAGE_SIZE;
  replies.length = Math.min(replies.length, REPLY_PAGE_SIZE);
  return {
    replies: replies.map((reply) => reply.toJSON()),
    nextCursor: hasMore ? String(replies.at(-1)._id) : null,
  };
}

export async function createThread(boardId, userId, { anchor, text }) {
  await getBoardRole(boardId, userId);
  let lastWorldX;
  let lastWorldY;
  if (anchor.type === 'canvas') {
    lastWorldX = anchor.x;
    lastWorldY = anchor.y;
  } else {
    const state = await getBoardState(boardId);
    const node = (state.graph.nodes ?? []).find((entry) => entry.id === anchor.nodeId);
    if (!node) throw ApiError.notFound('The node for this comment no longer exists');
    lastWorldX = node.x + anchor.offsetX;
    lastWorldY = node.y + anchor.offsetY;
  }

  const threadId = new mongoose.Types.ObjectId();
  const root = await Comment.create({
    _id: threadId,
    boardId,
    threadId,
    parentId: null,
    anchor,
    authorId: userId,
    text,
    resolved: false,
    lastWorldX,
    lastWorldY,
  });
  return root.populate('authorId', 'name avatarColor');
}

export async function replyToThread(boardId, threadId, userId, { text }) {
  await getBoardRole(boardId, userId);
  const root = await findRoot(boardId, threadId);
  if (root.deletedAt) throw ApiError.badRequest('This thread has been deleted');
  const reply = await Comment.create({
    boardId,
    threadId: root._id,
    parentId: root._id,
    authorId: userId,
    text,
  });
  return reply.populate('authorId', 'name avatarColor');
}

export async function setThreadResolved(boardId, threadId, userId, resolved) {
  const role = await getBoardRole(boardId, userId);
  const root = await findRoot(boardId, threadId);
  const isAuthor = String(root.authorId) === String(userId);
  if (!isAuthor && ROLE_RANK[role] < ROLE_RANK.editor) {
    throw ApiError.forbidden('Only the thread author, editors, or admins can resolve it');
  }
  root.resolved = resolved;
  root.resolvedBy = resolved ? userId : null;
  root.resolvedAt = resolved ? new Date() : null;
  await root.save();
  return root.populate('authorId resolvedBy', 'name avatarColor');
}

export async function editComment(boardId, commentId, userId, { text }) {
  await getBoardRole(boardId, userId);
  if (!mongoose.isValidObjectId(commentId)) throw ApiError.notFound('Comment not found');
  const comment = await Comment.findOne({ _id: commentId, boardId });
  if (!comment) throw ApiError.notFound('Comment not found');
  if (String(comment.authorId) !== String(userId)) {
    throw ApiError.forbidden('Only the comment author can edit it');
  }
  if (comment.deletedAt) throw ApiError.badRequest('Deleted comments cannot be edited');
  comment.text = text;
  comment.editedAt = new Date();
  await comment.save();
  return comment.populate('authorId', 'name avatarColor');
}

export async function deleteComment(boardId, commentId, userId) {
  const role = await getBoardRole(boardId, userId);
  if (!mongoose.isValidObjectId(commentId)) throw ApiError.notFound('Comment not found');
  const comment = await Comment.findOne({ _id: commentId, boardId });
  if (!comment) throw ApiError.notFound('Comment not found');
  const isAuthor = String(comment.authorId) === String(userId);
  if (!isAuthor && role !== 'admin') {
    throw ApiError.forbidden('Only the comment author or an admin can delete it');
  }
  if (!comment.deletedAt) {
    comment.deletedAt = new Date();
    comment.deletedBy = userId;
    await comment.save();
  }
  return { id: String(comment._id), deletedAt: comment.deletedAt };
}
