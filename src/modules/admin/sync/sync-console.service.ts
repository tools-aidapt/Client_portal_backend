import { config } from '@config/index.js';
import { AppError } from '@common/errors/index.js';
import { syncService, type SyncContext } from '@modules/sync/clickup/sync.service.js';
import { syncRepo } from '@modules/sync/clickup/sync.repository.js';
import {
  CASE_STUDY_FOLDER_ID,
  PROCESS_LIST_ID,
  WISHLIST_LIST_ID,
} from '@modules/sync/clickup/sync.constants.js';
import { syncConsoleRepo } from './sync-console.repository.js';

/**
 * The Sync Console's view of the sync surface.
 *
 * This deliberately does NOT re-implement any sync. It maps a stable entity
 * key to the existing `syncService` call, so the console and the cron run
 * exactly the same code — a console run that behaved differently from the
 * scheduled one would be worse than no console at all.
 *
 * The internal `/internal/sync/*` routes stay as they are: they are
 * service-secret, machine-facing, and n8n depends on them. This module is the
 * browser-facing sibling, authorised by platform-admin session instead, so
 * `INTERNAL_API_SECRET` never has to reach a frontend.
 */

export interface SyncEntityDef {
  key: string;
  label: string;
  description: string;
  /** Roughly how long a run takes, so the UI can warn before a long one. */
  scale: 'fast' | 'slow';
  run: (ctx: SyncContext) => Promise<{ upserted: number; skipped?: number; status?: string }>;
}

/**
 * Order matters for "Run everything": `sprints` refreshes the sprint list and
 * recomputes which one is active, and `spaces`/`sprint` route tasks against
 * that. Running them the other way round files this fortnight's tasks against
 * last fortnight's sprint.
 */
export const SYNC_ENTITIES: SyncEntityDef[] = [
  {
    key: 'sprints',
    label: 'Sprint definitions',
    description: 'Refreshes portal.sprints from the Sprints folder and recomputes which sprint is active by date.',
    scale: 'fast',
    run: (ctx) => syncService.refreshSprints(undefined, ctx).then((r) => ({ upserted: r.upserted })),
  },
  {
    key: 'spaces',
    label: 'Delivery spaces walk',
    description: 'The main pull. Walks every configured ClickUp space and upserts task_cache. This is what the hourly cron runs.',
    scale: 'slow',
    run: (ctx) => syncService.syncSpaces(config.clickup.spaceIds, ctx),
  },
  {
    key: 'sprint',
    label: 'Sprint list tasks',
    description: "Tasks on the active sprint's own ClickUp list, routed per task by Client Group.",
    scale: 'fast',
    run: (ctx) => syncService.syncSprint(ctx),
  },
  {
    key: 'wishlist',
    label: 'Wishlist',
    description: 'The shared wishlist intake list. Unrouted items are counted, never guessed at.',
    scale: 'fast',
    run: (ctx) => syncService.syncWishlist(WISHLIST_LIST_ID, ctx),
  },
  {
    key: 'onboarding',
    label: 'Onboarding requests',
    description: 'The shared ORG process list, one task per client engagement, routed by Client Group.',
    scale: 'fast',
    run: (ctx) => syncService.syncOnboardingRequests(PROCESS_LIST_ID, ctx),
  },
  {
    key: 'reports',
    label: 'Monthly reports',
    description: 'Walks every tenant with a reports folder and ingests its monthly report Docs.',
    scale: 'slow',
    run: (ctx) => syncService.syncReports({}, ctx),
  },
  {
    key: 'use_cases',
    label: 'Use case library',
    description: 'The Case Study Library folder — ~600 studies, the slowest run by some margin.',
    scale: 'slow',
    run: (ctx) => syncService.syncUseCases(CASE_STUDY_FOLDER_ID, ctx),
  },
];

export function findEntity(key: string): SyncEntityDef {
  const def = SYNC_ENTITIES.find((e) => e.key === key);
  if (!def) throw new AppError(`Unknown sync entity "${key}"`, 400, 'UNKNOWN_SYNC_ENTITY');
  return def;
}

export const syncConsoleService = {
  /**
   * Everything the console renders when idle. Reaps abandoned runs first, or a
   * process that died mid-walk would show as permanently "running" and the
   * lock check would refuse every future run.
   */
  async overview() {
    const reaped = await syncRepo.reapStaleRuns();
    const [summaries, folders, lists, totals] = await Promise.all([
      syncConsoleRepo.entitySummaries(),
      syncConsoleRepo.folderStats(),
      syncConsoleRepo.listStats(),
      syncConsoleRepo.totals(),
    ]);
    const byKey = new Map(summaries.map((s) => [s.entity, s]));
    return {
      entities: SYNC_ENTITIES.map((def) => ({
        key: def.key,
        label: def.label,
        description: def.description,
        scale: def.scale,
        last: byKey.get(def.key) ?? null,
      })),
      folders,
      lists,
      totals,
      reaped,
    };
  },

  /**
   * Run one entity under its advisory lock, streaming progress to `onEvent`.
   * Rejects with 409 rather than queueing — see `acquireLock`.
   */
  async runEntity(
    key: string,
    triggeredBy: string,
    onEvent: (e: { phase: string; message: string; count?: number; totalUpserted?: number }) => void,
  ) {
    const def = findEntity(key);
    const lock = await syncConsoleRepo.acquireLock(key);
    if (!lock) {
      const active = await syncConsoleRepo.runningRun(key);
      throw new AppError(
        active
          ? `"${def.label}" is already running (started ${active.started_at} by ${active.triggered_by_name ?? 'the scheduler'})`
          : `"${def.label}" is already running`,
        409,
        'SYNC_ALREADY_RUNNING',
      );
    }
    try {
      onEvent({ phase: 'scan', message: `Starting ${def.label}` });
      const result = await def.run({ onProgress: onEvent, triggeredBy });
      onEvent({
        phase: 'done',
        message: `${def.label} finished — ${result.upserted} stored${result.skipped ? `, ${result.skipped} skipped` : ''}`,
        totalUpserted: result.upserted,
      });
      return result;
    } finally {
      await lock.release();
    }
  },
};
