import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Board } from '../models/Board.js';
import { User } from '../models/User.js';
import { verifyAccessToken } from '../middleware/authenticate.js';
import { roleOfLean } from '../services/boardService.js';
import {
  applyOp,
  getAppliedOp,
  rememberAppliedOp,
  flushBoard,
  schedulePersist,
  withBoardLock,
} from '../services/boardState.js';
import { boardEvents, connectBoardEvents } from '../services/boardEvents.js';
import {
  canvasMessageSchema,
  commentCreateEventSchema,
  commentDeleteEventSchema,
  commentEditEventSchema,
  commentReplyEventSchema,
  commentThreadEventSchema,
} from '../validators/schemas.js';
import { ROLE_RANK } from '../utils/constants.js';
import { connectRedis, createRedisAdapterClients } from '../config/redis.js';
import { broadcastCursorLeave, handleCursorMove } from '../realtime/cursorSocket.js';
import { consumeCommentWrite } from '../realtime/commentRateLimit.js';
import * as commentService from '../services/commentService.js';
import {
  applyStickyUpdate,
  flushStickyDocs,
  getStickyDoc,
  normalizeStickyUpdate,
  removeStickyDoc,
  stickyRoom,
} from '../services/stickyNoteService.js';
import * as Y from 'yjs';

const boardRoom = (boardId) => `board:${boardId}`;

function describeError(error) {
  if (error?.issues?.length) return error.issues[0].message;
  return error?.message || 'Unexpected realtime error';
}

/**
 * Socket.IO gateway for live collaboration.
 *
 * Auth happens once per connection; authorisation for each board is resolved
 * from the database on join and the role is cached on the socket. Every canvas
 * mutation is validated and applied server-side before it is broadcast.
 */
export async function createRealtimeServer(httpServer) {
  await connectRedis();
  await connectBoardEvents();
  const useRedisAdapter = process.env.DISABLE_SOCKET_REDIS_ADAPTER !== 'true';
  let adapterClients = null;
  if (useRedisAdapter) adapterClients = await createRedisAdapterClients();
  const io = new Server(httpServer, {
    cors: { origin: env.allowedOrigins, credentials: true },
    maxHttpBufferSize: 1_000_000,
    pingTimeout: 25_000,
  });
  io.data = io.data ?? {};
  if (adapterClients) {
    io.adapter(createAdapter(adapterClients.pubClient, adapterClients.subClient));
    io.data.redisAdapterClose = adapterClients.close;
  }

  io.use(async (socket, next) => {
    try {
      const headerToken = socket.handshake.headers?.authorization?.split(' ')[1];
      const token = socket.handshake.auth?.token || headerToken;
      if (!token) throw new Error('Missing token');

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).select('name avatarColor').lean();
      if (!user) throw new Error('Account not found');

      socket.data.user = { id: String(user._id), name: user.name, avatarColor: user.avatarColor };
      socket.data.boards = new Map();
      socket.data.lastCursorAt = 0;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  async function broadcastPresence(boardId) {
    try {
      const sockets = await io.in(boardRoom(boardId)).fetchSockets();
      const users = new Map();
      for (const connected of sockets) {
        const user = connected.data.user;
        if (user) users.set(user.id, user);
      }
      io.to(boardRoom(boardId)).emit('presence:update', {
        boardId: String(boardId),
        users: [...users.values()],
      });
    } catch (error) {
      logger.warn({ err: error, boardId }, 'Failed to broadcast presence');
    }
  }

  async function flushIfBoardRoomIsEmpty(boardId) {
    try {
      // Fetching the room members works across instances when the Redis adapter
      // is enabled, so one server does not flush while another still has users.
      const sockets = await io.in(boardRoom(boardId)).fetchSockets();
      if (sockets.length > 0) return;

      await flushBoard(boardId);
      await flushStickyDocs(boardId);
      logger.info({ boardId }, 'Flushed board after its last socket left');
    } catch (error) {
      logger.error({ err: error, boardId }, 'Failed to flush board after its last socket left');
    }
  }

  io.on('connection', (socket) => {
    socket.on('board:join', async (payload, ack) => {
      try {
        const boardId = String(payload?.boardId ?? '');
        if (!mongoose.isValidObjectId(boardId)) throw new Error('Invalid board');

        if (!socket.data.boards.has(boardId)) {
          const board = await Board.findById(boardId).select('owner members').lean();
          if (!board) throw new Error('Board not found');

          const role = roleOfLean(board, socket.data.user.id);
          if (!role) throw new Error('You are not a member of this board');

          await socket.join(boardRoom(boardId));
          socket.data.boards.set(boardId, role);
        }

        ack?.({ ok: true, role: socket.data.boards.get(boardId) });
        await broadcastPresence(boardId);
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('board:leave', async (payload) => {
      const boardId = String(payload?.boardId ?? '');
      if (!socket.data.boards.has(boardId)) return;
      socket.data.boards.delete(boardId);
      await socket.leave(boardRoom(boardId));
      broadcastCursorLeave(socket, boardId);
      await flushIfBoardRoomIsEmpty(boardId);
      await broadcastPresence(boardId);
    });

    socket.on('sticky:join', async (payload, ack) => {
      const boardId = String(payload?.boardId ?? '');
      const nodeId = String(payload?.nodeId ?? '');
      try {
        const role = socket.data.boards.get(boardId);
        if (!role) throw new Error('Join the board before editing sticky notes');

        const doc = await getStickyDoc(boardId, nodeId);
        await socket.join(stickyRoom(boardId, nodeId));
        const fullUpdate = Y.encodeStateAsUpdate(doc);
        console.log('[sticky] Viewer/editor joined Y.Doc', { boardId, nodeId, role });
        ack?.({ ok: true, update: fullUpdate });
      } catch (error) {
        console.log('[sticky] Join rejected', { boardId, nodeId, error: describeError(error) });
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('sticky:update', async (payload, ack) => {
      const boardId = String(payload?.boardId ?? '');
      const nodeId = String(payload?.nodeId ?? '');
      try {
        // A role can change while this socket stays connected.
        // Re-read MongoDB for every sticky update instead of trusting the cache.
        if (!mongoose.isValidObjectId(boardId)) throw new Error('Invalid board');
        const board = await Board.findById(boardId).select('owner members').lean();
        if (!board) throw new Error('Board not found');

        const role = roleOfLean(board, socket.data.user.id);
        if (!role) {
          console.log('[sticky] Removed member update rejected', {
            boardId,
            nodeId,
            userId: socket.data.user.id,
          });
          ack?.({ ok: false, error: 'You are no longer a member of this board' });
          return;
        }
        if (ROLE_RANK[role] < ROLE_RANK.editor) {
          console.log('[sticky] Viewer update rejected', { boardId, nodeId, role });
          ack?.({ ok: false, error: 'Viewers cannot edit sticky notes' });
          return;
        }

        let update;
        try {
          update = normalizeStickyUpdate(payload?.update);
        } catch (error) {
          ack?.({ ok: false, error: describeError(error) });
          console.log('[sticky] Invalid payload rejected', {
            boardId,
            nodeId,
            error: describeError(error),
          });
          return;
        }

        await applyStickyUpdate(boardId, nodeId, update);
        socket.to(stickyRoom(boardId, nodeId)).emit('sticky:update', {
          boardId,
          nodeId,
          update,
        });
        ack?.({ ok: true });
      } catch (error) {
        console.log('[sticky] Update rejected', { boardId, nodeId, error: describeError(error) });
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    function checkCommentWriteLimit(ack) {
      if (consumeCommentWrite(socket)) return true;
      ack?.({ ok: false, error: 'Too many comment changes. Please wait a minute and try again.' });
      return false;
    }

    function requireJoinedBoard(boardId) {
      if (!socket.data.boards.has(boardId)) throw new Error('Join the board before commenting');
    }

    socket.on('comment:create', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentCreateEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const thread = await commentService.createThread(
          message.boardId,
          socket.data.user.id,
          { anchor: message.anchor, text: message.text },
        );
        const result = { boardId: message.boardId, thread: thread.toJSON() };
        io.to(boardRoom(message.boardId)).emit('comment:created', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('comment:reply', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentReplyEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const reply = await commentService.replyToThread(
          message.boardId,
          message.threadId,
          socket.data.user.id,
          { text: message.text },
        );
        const result = { boardId: message.boardId, threadId: message.threadId, reply: reply.toJSON() };
        io.to(boardRoom(message.boardId)).emit('comment:replied', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('comment:resolve', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentThreadEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const thread = await commentService.setThreadResolved(
          message.boardId,
          message.threadId,
          socket.data.user.id,
          true,
        );
        const result = { boardId: message.boardId, thread: thread.toJSON() };
        io.to(boardRoom(message.boardId)).emit('comment:resolved', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('comment:edit', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentEditEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const comment = await commentService.editComment(
          message.boardId,
          message.commentId,
          socket.data.user.id,
          { text: message.text },
        );
        const result = { boardId: message.boardId, comment: comment.toJSON() };
        io.to(boardRoom(message.boardId)).emit('comment:edited', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('comment:reopen', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentThreadEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const thread = await commentService.setThreadResolved(
          message.boardId,
          message.threadId,
          socket.data.user.id,
          false,
        );
        const result = { boardId: message.boardId, thread: thread.toJSON() };
        io.to(boardRoom(message.boardId)).emit('comment:reopened', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('comment:delete', async (payload, ack) => {
      if (!checkCommentWriteLimit(ack)) return;
      try {
        const message = commentDeleteEventSchema.parse(payload);
        requireJoinedBoard(message.boardId);
        const deleted = await commentService.deleteComment(
          message.boardId,
          message.commentId,
          socket.data.user.id,
        );
        const result = { boardId: message.boardId, commentId: message.commentId, ...deleted };
        io.to(boardRoom(message.boardId)).emit('comment:deleted', result);
        ack?.({ ok: true, ...result });
      } catch (error) {
        ack?.({ ok: false, error: describeError(error) });
      }
    });

    socket.on('canvas:op', async (payload, ack) => {
      const opId = String(payload?.opId ?? '');
      let currentRevision;
      try {
        const boardId = String(payload?.boardId ?? '');
        const role = socket.data.boards.get(boardId);
        if (!role) throw new Error('Join the board before editing');
        if (ROLE_RANK[role] < ROLE_RANK.editor) throw new Error('Viewers have read-only access');

        const message = canvasMessageSchema.parse({
          opId: payload?.opId,
          baseRevision: payload?.baseRevision,
          op: payload?.op,
        });
        const result = await withBoardLock(boardId, async (state) => {
          currentRevision = state.revision;
          const previousRevision = getAppliedOp(state, message.opId);
          if (previousRevision !== undefined) {
            return { duplicate: true, revision: previousRevision };
          }

          const isPositionOrSizePatch =
            message.op.type === 'node.update'
            && Object.keys(message.op.patch).every((key) => ['x', 'y', 'width', 'height'].includes(key));

          // Position and size changes do not overwrite other node fields.
          // Only require a current revision for create/delete and other patches.
          if (message.baseRevision !== state.revision && !isPositionOrSizePatch) {
            const error = new Error(
              `This change is based on revision ${message.baseRevision}, but the board is at revision ${state.revision}`,
            );
            error.code = 'STALE_REVISION';
            throw error;
          }

          applyOp(state, message.op, socket.data.user.id);
          // A deleted sticky note must not keep an in-memory Y.Doc or save timer.
          if (message.op.type === 'node.delete') {
            removeStickyDoc(boardId, message.op.nodeId);
          }
          rememberAppliedOp(state, message.opId, state.revision);
          schedulePersist(boardId);
          return { duplicate: false, revision: state.revision };
        });

        if (!result.duplicate) {
          socket.to(boardRoom(boardId)).emit('canvas:op', {
            boardId,
            opId: message.opId,
            op: message.op,
            revision: result.revision,
            actor: socket.data.user,
          });
        }
        ack?.({ ok: true, opId: message.opId, revision: result.revision });
      } catch (error) {
        ack?.({ ok: false, opId, revision: currentRevision, error: describeError(error) });
      }
    });

    socket.on('cursor:move', (payload) => {
      handleCursorMove(socket, payload);
    });

    socket.on('disconnect', () => {
      for (const boardId of socket.data.boards.keys()) {
        broadcastCursorLeave(socket, boardId);
        broadcastPresence(boardId);
        flushIfBoardRoomIsEmpty(boardId);
      }
    });
  });

  boardEvents.on('board:replaced', ({ boardId, graph, revision, snapshotName }) => {
    io.to(boardRoom(boardId)).emit('board:replaced', { boardId, graph, revision, snapshotName });
  });

  boardEvents.on('sticky:resync', ({ boardId }) => {
    io.to(boardRoom(boardId)).emit('sticky:resync', { boardId });
  });

  boardEvents.on('board:updated', (payload) => {
    io.to(boardRoom(payload.boardId)).emit('board:updated', payload);
  });

  boardEvents.on('board:member-access-changed', async ({ boardId, userId }) => {
    try {
      const sockets = await io.in(boardRoom(boardId)).fetchSockets();
      for (const connected of sockets) {
        if (connected.data.user?.id === String(userId)) {
          // Drop the old cached role immediately.
          connected.disconnect(true);
          logger.info({ boardId, userId }, 'Revoked board socket access');
        }
      }
    } catch (error) {
      logger.warn({ err: error, boardId, userId }, 'Failed to revoke board socket access');
    }
  });

  boardEvents.on('board:deleted', ({ boardId }) => {
    io.to(boardRoom(boardId)).emit('board:deleted', { boardId });
    io.in(boardRoom(boardId)).disconnectSockets(true);
  });

  return io;
}
