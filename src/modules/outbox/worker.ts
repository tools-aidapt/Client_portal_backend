import { logger } from '@infra/logger/index.js';
import { outboxRepo } from './outbox.repository.js';
import { handlers } from './handlers.js';
import { failOnboarding, finalizeOnboarding } from './finalizer.js';

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;

export interface DrainSummary {
  processed: number;
  done: number;
  retried: number;
  dead: number;
}

/** Exponential backoff capped at 60s. `attempts` = tries already made. */
function backoffMs(attempts: number): number {
  return Math.min(60_000, BASE_BACKOFF_MS * 2 ** attempts);
}

/**
 * Process one batch of due outbox events. Safe to call repeatedly (cron) or in
 * a loop (worker process). Returns a summary of what happened.
 */
export async function drainOnce(limit = 20): Promise<DrainSummary> {
  const batch = await outboxRepo.claimBatch(limit);
  const summary: DrainSummary = { processed: batch.length, done: 0, retried: 0, dead: 0 };

  for (const row of batch) {
    const handler = handlers[row.event_type];
    try {
      if (!handler) throw new Error(`No handler for event_type '${row.event_type}'`);
      await handler(row);
      await outboxRepo.markDone(row.id);
      summary.done++;

      // If this was the last outstanding event for the aggregate, finalize.
      if (row.aggregate === 'onboarding' && (await outboxRepo.allEventsDone(row.aggregate_id))) {
        await finalizeOnboarding(row.aggregate_id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const triesMade = row.attempts + 1;
      if (triesMade >= MAX_ATTEMPTS) {
        await outboxRepo.markDead(row.id, message);
        summary.dead++;
        if (row.aggregate === 'onboarding') await failOnboarding(row.aggregate_id, message);
      } else {
        await outboxRepo.markRetry(row.id, message, backoffMs(row.attempts));
        summary.retried++;
      }
      logger.warn({ id: row.id, event: row.event_type, err: message }, 'Outbox event failed');
    }
  }

  return summary;
}

/**
 * Long-running worker loop for a dedicated process. Polls every `intervalMs`.
 */
export async function runWorkerLoop(intervalMs = 3_000): Promise<never> {
  logger.info({ intervalMs }, 'Outbox worker loop started');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const summary = await drainOnce();
      if (summary.processed > 0) logger.info(summary, 'Outbox batch drained');
    } catch (err) {
      logger.error({ err }, 'Outbox drain iteration failed');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
