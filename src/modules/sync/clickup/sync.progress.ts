/**
 * Optional progress reporting for the sync services.
 *
 * The sync methods were written for a cron that only ever read the final
 * `SyncResult`, so nothing existed to answer "what is it doing right now" —
 * which is the entire point of the Sync Console. Rather than fork the
 * services into a streaming and a non-streaming variant (two code paths that
 * would drift), each takes an OPTIONAL context.
 *
 * `emit` is a no-op when no context is supplied, so the cron/n8n path behaves
 * exactly as before: same queries, same result, no branching beyond one
 * undefined check per event.
 *
 * Events are advisory, never load-bearing. A sync must complete correctly
 * whether or not anyone is listening, so `emit` swallows anything the
 * consumer throws — a browser that hung up mid-stream must not roll back a
 * ClickUp walk that already wrote rows.
 */
import { logger } from '@infra/logger/index.js';

export type SyncPhase =
  /** A unit of source data was opened — a space, folder, list or doc. */
  | 'scan'
  /** Rows were written to the Portal's own tables. */
  | 'store'
  /** Source data was deliberately not stored, with the reason. */
  | 'skip'
  /** Terminal, once per run. */
  | 'done'
  | 'error';

export interface SyncEvent {
  phase: SyncPhase;
  message: string;
  /** Records affected by THIS event, where meaningful. */
  count?: number;
  /** Running total for the whole run, where known. */
  totalUpserted?: number;
}

export interface SyncContext {
  onProgress?: (event: SyncEvent) => void;
  /** Profile that triggered this run; null/undefined for the cron. */
  triggeredBy?: string | null;
}

/** Report progress if anyone is listening. Never throws into the sync. */
export function emit(ctx: SyncContext | undefined, event: SyncEvent): void {
  if (!ctx?.onProgress) return;
  try {
    ctx.onProgress(event);
  } catch (err) {
    // A dead listener is not a sync failure.
    logger.warn({ err }, 'sync progress listener threw — continuing');
  }
}
