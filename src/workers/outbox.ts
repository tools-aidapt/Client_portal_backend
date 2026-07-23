import { runWorkerLoop } from '@modules/outbox/worker.js';
import { logger } from '@infra/logger/index.js';
import { pool } from '@infra/db/pool.js';

/**
 * Standalone outbox worker process. Run alongside the API:
 *   npm run worker:outbox
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — outbox worker shutting down`);
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void runWorkerLoop();
