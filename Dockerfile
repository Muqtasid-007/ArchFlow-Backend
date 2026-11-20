# syntax=docker/dockerfile:1
# ArchFlow API — production image.
# Runtime dependencies only; the source is copied read-only and the process
# runs as the unprivileged `node` user.

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node src ./src

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The app handles SIGTERM by flushing live board state before exiting.
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
