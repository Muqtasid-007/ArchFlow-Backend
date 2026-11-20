const WINDOW_MS = 60_000;
export const COMMENT_WRITES_PER_SOCKET_PER_MINUTE = 30;

/** Fixed-window write limit; the state lives only for this connected socket. */
export function consumeCommentWrite(socket, now = Date.now()) {
  let window = socket.data.commentWriteWindow;
  if (!window || now - window.startedAt >= WINDOW_MS) {
    window = { startedAt: now, count: 0 };
    socket.data.commentWriteWindow = window;
  }
  if (window.count >= COMMENT_WRITES_PER_SOCKET_PER_MINUTE) return false;
  window.count += 1;
  return true;
}
