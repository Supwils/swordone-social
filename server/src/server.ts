import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDb, disconnectDb } from './db/client';
import { createSessionMiddleware } from './config/session';
import { initRealtime } from './realtime/io';
import { closeRedisAdapter } from './realtime/adapter';
import { initMonitoring, captureException } from './lib/monitoring';
import { logger } from './lib/logger';
import { startFeedScoreRefresher } from './lib/feedScorer';

async function bootstrap(): Promise<void> {
  // Init monitoring BEFORE any other work so boot-time errors are captured.
  await initMonitoring();

  await connectDb();

  // The same session middleware instance is shared by express and socket.io engines.
  const sessionMiddleware = createSessionMiddleware();
  const app = createApp({ sessionMiddleware });
  const httpServer = createServer(app);

  initRealtime(httpServer, sessionMiddleware);

  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
  });
  const stopFeedScores = env.NODE_ENV === 'test' ? () => undefined : startFeedScoreRefresher();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopFeedScores();
    httpServer.close(async () => {
      await closeRedisAdapter();
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('force exit after 10s');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
    void captureException(reason);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void captureException(err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('fatal bootstrap error', err);
  process.exit(1);
});
