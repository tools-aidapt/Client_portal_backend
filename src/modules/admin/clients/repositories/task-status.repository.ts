import { pool } from '@infra/db/pool.js';
import { NotFoundError, ValidationError } from '@common/errors/index.js';

/** One row of the client-facing status catalogue (`portal.task_statuses`). */
export interface TaskStatus {
  key: string;
  label: string;
  tone: 'neutral' | 'info' | 'warning' | 'error' | 'success' | 'teal';
  bucket: 'delivered' | 'in_progress' | 'upcoming';
  sort_order: number;
  description: string | null;
}

/** What a task's status looks like after a manual change. */
export interface TaskStatusState {
  clickup_task_id: string;
  name: string;
  /** ClickUp's own status, exactly as synced. */
  status_raw: string | null;
  /** Catalogue key the sync resolved from `status_raw`. */
  synced_status_key: string | null;
  /** The manual pin, if any. */
  status_override_key: string | null;
  status_override_at: string | null;
  /** Effective status = override, else synced. */
  status_key: string | null;
  status_label: string | null;
  status_tone: TaskStatus['tone'] | null;
  bucket: TaskStatus['bucket'] | null;
}

/**
 * Admin control over a cached task's status, independent of ClickUp.
 *
 * The Hub mirrors ClickUp hourly, but delivery sometimes moves faster than the
 * board does (a phase is in UAT with the client before anyone flips the ClickUp
 * status), and the client is looking at the Hub, not the board. So a platform
 * admin can set the status here, on a phase or a subtask alike. Nothing is
 * written back to ClickUp; the pin lives only in `task_cache` and the sync
 * drops it the next time ClickUp's own status changes (see `upsertTask`).
 */
export const taskStatusRepo = {
  /** The full catalogue, in display order. Small and global, so no caching. */
  async catalogue(): Promise<TaskStatus[]> {
    const { rows } = await pool.query<TaskStatus>(
      `select key, label, tone, bucket, sort_order, description
         from portal.task_statuses
        order by sort_order`,
    );
    return rows;
  },

  /**
   * Pin a task's status to `statusKey`, or clear the pin with `null` so it
   * follows ClickUp again. `bucket` is rewritten to match the EFFECTIVE status
   * so every count (phase_done, dashboard tiles, report deliveries) agrees with
   * the badge the client sees.
   *
   * Scoped by tenant as well as task id: the admin acts within one client's
   * Portal, and a guessed ClickUp id must not reach another client's row.
   */
  async setOverride(
    tenantId: string,
    clickupTaskId: string,
    statusKey: string | null,
    userId: string,
  ): Promise<TaskStatusState> {
    if (statusKey) {
      const { rowCount } = await pool.query(`select 1 from portal.task_statuses where key = $1`, [statusKey]);
      if (!rowCount) throw new ValidationError(`Unknown status "${statusKey}"`);
    }

    const { rows } = await pool.query<{ clickup_task_id: string }>(
      `update portal.task_cache tc
          set status_override_key = $3,
              status_override_by  = case when $3::text is null then null else $4::uuid end,
              status_override_at  = case when $3::text is null then null else now() end,
              bucket = coalesce(
                (select s.bucket from portal.task_statuses s where s.key = coalesce($3::text, tc.status_key)),
                tc.bucket)
        where tc.clickup_task_id = $1 and tc.tenant_id = $2
        returning tc.clickup_task_id`,
      [clickupTaskId, tenantId, statusKey, userId],
    );
    if (!rows[0]) throw new NotFoundError('No cached task with that ClickUp id for this client');
    return (await this.get(tenantId, clickupTaskId))!;
  },

  /**
   * Pin a whole project's status, or clear the pin with `null` so it is derived
   * from its phases again. Scoped to the tenant's own project lists.
   */
  async setProjectOverride(
    tenantId: string,
    listId: string,
    statusKey: string | null,
    userId: string,
  ): Promise<{ clickup_list_id: string; status_override_key: string | null }> {
    if (statusKey) {
      const { rowCount } = await pool.query(`select 1 from portal.task_statuses where key = $1`, [statusKey]);
      if (!rowCount) throw new ValidationError(`Unknown status "${statusKey}"`);
    }
    const { rows } = await pool.query<{ clickup_list_id: string; status_override_key: string | null }>(
      `update portal.clickup_list_mappings
          set status_override_key = $3,
              status_override_by  = case when $3::text is null then null else $4::uuid end,
              status_override_at  = case when $3::text is null then null else now() end
        where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'
        returning clickup_list_id, status_override_key`,
      [tenantId, listId, statusKey, userId],
    );
    if (!rows[0]) throw new NotFoundError('Project not found for this client');
    return rows[0];
  },

  /** Current status state of one cached task, or null if it isn't this tenant's. */
  async get(tenantId: string, clickupTaskId: string): Promise<TaskStatusState | null> {
    const { rows } = await pool.query<TaskStatusState>(
      `select tc.clickup_task_id, tc.name, tc.status_raw,
              tc.status_key as synced_status_key,
              tc.status_override_key, tc.status_override_at,
              coalesce(tc.status_override_key, tc.status_key) as status_key,
              s.label as status_label, s.tone as status_tone, tc.bucket
         from portal.task_cache tc
         left join portal.task_statuses s on s.key = coalesce(tc.status_override_key, tc.status_key)
        where tc.clickup_task_id = $1 and tc.tenant_id = $2`,
      [clickupTaskId, tenantId],
    );
    return rows[0] ?? null;
  },
};
