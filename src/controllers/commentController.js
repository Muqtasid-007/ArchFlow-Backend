import * as commentService from '../services/commentService.js';

export async function listThreads(req, res) {
  const result = await commentService.listThreads(
    req.board._id,
    req.user._id,
    req.validated.query,
  );
  res.json(result);
}

export async function getReplies(req, res) {
  const result = await commentService.getReplies(
    req.board._id,
    req.params.threadId,
    req.user._id,
    req.validated.query.cursor,
  );
  res.json(result);
}

export async function createThread(req, res) {
  const thread = await commentService.createThread(req.board._id, req.user._id, req.body);
  res.status(201).json({ thread: thread.toJSON() });
}

export async function replyToThread(req, res) {
  const reply = await commentService.replyToThread(
    req.board._id,
    req.params.threadId,
    req.user._id,
    req.body,
  );
  res.status(201).json({ reply: reply.toJSON() });
}

export async function resolveThread(req, res) {
  const thread = await commentService.setThreadResolved(
    req.board._id,
    req.params.threadId,
    req.user._id,
    true,
  );
  res.json({ thread: thread.toJSON() });
}

export async function reopenThread(req, res) {
  const thread = await commentService.setThreadResolved(
    req.board._id,
    req.params.threadId,
    req.user._id,
    false,
  );
  res.json({ thread: thread.toJSON() });
}

export async function deleteComment(req, res) {
  const result = await commentService.deleteComment(req.board._id, req.params.commentId, req.user._id);
  res.json(result);
}
