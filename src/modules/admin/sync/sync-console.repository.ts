import { pool } from '@infra/db/pool.js';

/**
 * Read models for the Sync Console, plus the cross-process lock that keeps a
 * manual run from colliding with the hourly cron.
 *
 * Every count here comes from the Portal's OWN tables, never from ClickUp.
 * The console is a diagnostic for "what did we actually store", and it loads
 * on every visit — querying ClickUp per page view would spend the shared
 * `CLICKUP_API_TOKEN` budget that the whole sync depends on, to answer a
 * question the local tables already answer for free.
 */

export interface EntitySummary {
  entity: string;
  last_status: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_upserted: number | null;
  last_error: string | null;
  triggered_by_name: string | null;
  is_running: boolean;
}

export interface FolderStat {
  tenant_id: string | null;
  tenant_name: string;
  clickup_folder_id: string | null;
  lists: number;
  tasks: number;
  visible_tasks: number;
  last_task_sync: string | null;
}

export interface ListStat {
  tenant_name: string;
  clickup_list_id: string;
  display_label: string | null;
  purpose: string | null;
  is_active: boolean;
  client_visible: boolean;
  tasks: number;
}

export const syncConsoleRepo = {
  /**
   * Latest run per entity. `distinct on` rather than a window function because
   * it pairs with the (entity, started_at desc) index from migration `0038`.
   */
  async entitySummaries(): Promise<EntitySummary[]> {
    const { rows } = await pool.query<EntitySummary>(
      `select distinct on (r.entity)
              r.entity,
              r.status::text        as last_status,
              r.started_at          as last_started_at,
              r.finished_at         as last_finished_at,
              r.records_upserted    as last_upserted,
              r.error_detail        as last_error,
              p.full_name           as triggered_by_name,
              (r.status = 'running') as is_running
         from portal.sync_runs r
         left join core.profiles p on p.id = r.triggered_by
        order by r.entity, r.started_at desc`,
    );
    return rows;
  },

  /** Per-client cached totals — the "is this client's data actually here" view. */
  async folderStats(): Promise<FolderStat[]> {
    const { rows } = await pool.query<FolderStat>(
      `select t.id                                as tenant_id,
              t.name                              as tenant_name,
              t.clickup_folder_id,
              (select count(*)::int from portal.clickup_list_mappings m
                where m.tenant_id = t.id and m.is_active)                       as lists,
              (select count(*)::int from portal.task_cache tc
                where tc.tenant_id = t.id)                                      as tasks,
              (select count(*)::int from portal.task_cache tc
                where tc.tenant_id = t.id and tc.client_visible)                as visible_tasks,
              (select max(tc.synced_at) from portal.task_cache tc
                where tc.tenant_id = t.id)                                      as last_task_sync
         from core.tenants t
        order by t.name`,
    );
    return rows;
  },

  /** Every mapped list with what the Portal currently holds for it. */
  async listStats(): Promise<ListStat[]> {
    const { rows } = await pool.query<ListStat>(
      `select t.name as tenant_name,
              m.clickup_list_id,
              m.display_label,
              m.purpose::text as purpose,
              m.is_active,
              m.client_visible,
              (select count(*)::int from portal.task_cache tc
                where tc.clickup_list_id = m.clickup_list_id
                  and tc.tenant_id = m.tenant_id) as tasks
         from portal.clickup_list_mappings m
         join core.tenants t on t.id = m.tenant_id
        order by t.name, m.display_label nulls last`,
    );
    return rows;
  },

  /** Totals for the header strip. */
  async totals(): Promise<Record<string, number>> {
    const { rows } = await pool.query<Record<string, number>>(
      `select (select count(*)::int from portal.task_cache)            as tasks,
              (select count(*)::int from portal.use_cases)             as use_cases,
              (select count(*)::int from portal.wishlist_items)        as wishlist_items,
              (select count(*)::int from portal.reports)               as reports,
              (select count(*)::int from portal.clickup_list_mappings
                where is_active)                                       as active_lists,
              (select count(*)::int from core.tenants)                 as tenants`,
    );
    return rows[0]!;
  },

  /**
   * Try to claim the sync lock for `entity`. Postgres advisory locks are used
   * rather than a row flag because they are held by the SESSION and released
   * automatically if the process dies — a crashed run cannot leave the console
   * permanently jammed, which a boolean column absolutely can.
   *
   * `pg_try_advisory_lock` never waits: a second admin (or the cron landing
   * mid-run) is told who holds it instead of silently queueing behind a
   * two-minute walk.
   *
   * Returns the dedicated client when the lock is won — the caller MUST call
   * the returned `release`, and must run nothing on the pool in between
   * expecting the lock to apply, since the lock lives on this connection only.
   */
  async acquireLock(entity: string): Promise<{ release: () => Promise<void> } | null> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        `select pg_try_advisory_lock(hashtext('portal.sync:' || $1)) as locked`,
        [entity],
      );
      if (!rows[0]?.locked) {
        client.release();
        return null;
      }
      return {
        release: async () => {
          try {
            await client.query(`select pg_advisory_unlock(hashtext('portal.sync:' || $1))`, [entity]);
          } finally {
            client.release();
          }
        },
      };
    } catch (err) {
      client.release();
      throw err;
    }
  },

  /** Who/what is currently running, for a 409 that actually explains itself. */
  async runningRun(entity: string): Promise<{ started_at: string; triggered_by_name: string | null } | null> {
    const { rows } = await pool.query<{ started_at: string; triggered_by_name: string | null }>(
      `select r.started_at, p.full_name as triggered_by_name
         from portal.sync_runs r
         left join core.profiles p on p.id = r.triggered_by
        where r.entity = $1 and r.status = 'running'
        order by r.started_at desc limit 1`,
      [entity],
    );
    return rows[0] ?? null;
  },
};
