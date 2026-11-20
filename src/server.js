import http from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { disconnectRedis } from './config/redis.js';
import { disconnectBoardEvents } from './services/boardEvents.js';
import { flushStickyDocs } from './services/stickyNoteService.js';
import { createRealtimeServer } from './sockets/index.js';
import { flushAllBoards } from './services/boardState.js';

async function bootstrap() {
  await connectDatabase();

  const httpServer = http.createServer(app);
  const io = await createRealtimeServer(httpServer);

  httpServer.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'ArchFlow API listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await flushAllBoards();
      await flushStickyDocs();
      io.close();
      await io.data.redisAdapterClose?.();
      await new Promise((resolve) => httpServer.close(resolve));
      await disconnectBoardEvents();
      await disconnectRedis();
      await disconnectDatabase();
      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled rejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  return { httpServer, io };
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});
