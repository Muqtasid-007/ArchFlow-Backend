const CURSOR_MIN_INTERVAL_MS = 30;

export function handleCursorMove(socket, payload) {
  const boardId = String(payload?.boardId ?? '');
  const role = socket.data.boards.get(boardId);
  if (!role) return;

  const now = Date.now();
  if (now - socket.data.lastCursorAt < CURSOR_MIN_INTERVAL_MS) return;
  socket.data.lastCursorAt = now;

  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (Math.abs(x) > 200_000 || Math.abs(y) > 200_000) return;

  socket.to(`board:${boardId}`).emit('cursor:move', {
    boardId,
    user: socket.data.user,
    x,
    y,
  });
}

export function broadcastCursorLeave(socket, boardId) {
  socket.to(`board:${boardId}`).emit('cursor:leave', {
    boardId,
    userId: socket.data.user.id,
    name: socket.data.user.name,
  });
}
