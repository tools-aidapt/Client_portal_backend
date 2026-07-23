import { app } from './app.js';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(
    `🚀 Server listening on http://${config.server.host}:${config.server.port}${config.server.apiPrefix}`,
  );
});

/** Graceful shutdown so in-flight requests can drain before exit. */
function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force-exit if shutdown hangs.
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});
