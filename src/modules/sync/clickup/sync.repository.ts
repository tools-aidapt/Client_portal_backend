import { pool } from '@infra/db/pool.js';
import type { TaskBucket, TaskCacheUpsert } from './mapper.js';

export const syncRepo = {
  /**
   * Status -> bucket map for a tenant, merged over the global default
   * (tenant-specific rows win). Keys are lowercased raw statuses.
   */
  async getStatusMap(tenantId: string): Promise<Map<string, TaskBucket>> {
    const { rows } = await pool.query<{ raw_status: string; bucket: TaskBucket }>(
      `select raw_status, bucket from portal.clickup_status_map
        where tenant_id is null or tenant_id = $1
        order by (tenant_id is null)`, // globals first, tenant rows overwrite
      [tenantId],
    );
    const map = new Map<string, TaskBucket>();
    for (const r of rows) map.set(r.raw_status.toLowerCase(), r.bucket);
    return map;
  },

  /**
   * Register (or refresh the name of) a project = a ClickUp list under a client
   * folder. Preserves the admin-set client_visible flag on conflict.
   */
  async upsertProject(tenantId: string, listId: string, name: string): Promise<void> {
    await pool.query(
      `insert into portal.clickup_list_mappings
         (tenant_id, purpose, clickup_list_id, display_label, is_active)
       values ($1, 'project', $2, $3, true)
       on conflict (tenant_id, clickup_list_id)
       do update set display_label = excluded.display_label, is_active = true`,
      [tenantId, listId, name],
    );
  },

  /** All projects for a tenant (for the admin projects screen). */
  async listProjects(
    tenantId: string,
  ): Promise<Array<{ clickup_list_id: string; display_label: string | null; client_visible: boolean; is_active: boolean }>> {
    const { rows } = await pool.query(
      `select clickup_list_id, display_label, client_visible, is_active
         from portal.clickup_list_mappings
        where tenant_id = $1 and purpose = 'project'
        order by display_label`,
      [tenantId],
    );
    return rows as Array<{
      clickup_list_id: string;
      display_label: string | null;
      client_visible: boolean;
      is_active: boolean;
    }>;
  },

  /** Toggle a project's portal visibility. Returns false if no such project. */
  async setProjectVisibility(tenantId: string, listId: string, visible: boolean): Promise<boolean> {
    const { rowCount } = await pool.query(
      `update portal.clickup_list_mappings set client_visible = $3
        where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'`,
      [tenantId, listId, visible],
    );
    return (rowCount ?? 0) > 0;
  },

  /** listId -> client_visible for a tenant's projects (loaded once per sync). */
  async getProjectVisibilityMap(tenantId: string): Promise<Map<string, boolean>> {
    const { rows } = await pool.query<{ clickup_list_id: string; client_visible: boolean }>(
      `select clickup_list_id, client_visible from portal.clickup_list_mappings
        where tenant_id = $1 and purpose = 'project'`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.clickup_list_id, r.client_visible]));
  },

  /** Active delivery/project list ids mapped for a tenant. */
  async getDeliveryListIds(tenantId: string): Promise<string[]> {
    const { rows } = await pool.query<{ clickup_list_id: string }>(
      `select clickup_list_id from portal.clickup_list_mappings
        where tenant_id = $1 and is_active = true and purpose in ('project','onboarding')`,
      [tenantId],
    );
    return rows.map((r) => r.clickup_list_id);
  },

  async resolveTenantByClientGroup(group: string): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from core.tenants where clickup_client_group = $1 limit 1`,
      [group],
    );
    return rows[0]?.id ?? null;
  },

  async getTenantFolderId(tenantId: string): Promise<string | null> {
    const { rows } = await pool.query<{ clickup_folder_id: string | null }>(
      `select clickup_folder_id from core.tenants where id = $1`,
      [tenantId],
    );
    return rows[0]?.clickup_folder_id ?? null;
  },

  async resolveTenantByFolderId(folderId: string): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from core.tenants where clickup_folder_id = $1 limit 1`,
      [folderId],
    );
    return rows[0]?.id ?? null;
  },

  async resolveTenantByListId(listId: string): Promise<string | null> {
    const { rows } = await pool.query<{ tenant_id: string }>(
      `select tenant_id from portal.clickup_list_mappings where clickup_list_id = $1 limit 1`,
      [listId],
    );
    return rows[0]?.tenant_id ?? null;
  },

  async getActiveSprintByListId(listId: string): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from portal.sprints where clickup_list_id = $1 and is_active = true limit 1`,
      [listId],
    );
    return rows[0]?.id ?? null;
  },

  /** Active-sprint list ids the Portal tracks. */
  async getActiveSprints(): Promise<Array<{ id: string; clickup_list_id: string }>> {
    const { rows } = await pool.query<{ id: string; clickup_list_id: string }>(
      `select id, clickup_list_id from portal.sprints where is_active = true`,
    );
    return rows;
  },

  async upsertSprint(s: {
    clickupListId: string;
    name: string;
    sprintNumber: number | null;
    startsOn: string | null;
    endsOn: string | null;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into portal.sprints (clickup_list_id, name, sprint_number, starts_on, ends_on, synced_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (clickup_list_id) do update
         set name = excluded.name, sprint_number = excluded.sprint_number,
             starts_on = excluded.starts_on, ends_on = excluded.ends_on, synced_at = now()
       returning id`,
      [s.clickupListId, s.name, s.sprintNumber, s.startsOn, s.endsOn],
    );
    return rows[0]!.id;
  },

  /** Recompute is_active: a sprint is active when today falls in [starts_on, ends_on]. */
  async recomputeActiveSprints(): Promise<number> {
    const { rowCount } = await pool.query(
      `update portal.sprints
          set is_active = (starts_on is not null and ends_on is not null
                           and current_date between starts_on and ends_on)`,
    );
    return rowCount ?? 0;
  },

  /** Idempotent upsert keyed by clickup_task_id. */
  async upsertTask(t: TaskCacheUpsert): Promise<void> {
    await pool.query(
      `insert into portal.task_cache
         (tenant_id, clickup_task_id, source, sprint_id, clickup_list_id, list_name,
          name, status_raw, bucket, rag, progress_pct, type_of_work, client_visible,
          assignee_names, start_date, due_date, closed_at, url, synced_at)
       values ($1,$2,$3::portal.task_source,$4,$5,$6,$7,$8,$9::portal.task_bucket,
               $10::portal.rag_status,$11,$12,$13,$14::text[],$15,$16,$17,$18, now())
       on conflict (clickup_task_id) do update set
         tenant_id = excluded.tenant_id,
         source = excluded.source,
         sprint_id = excluded.sprint_id,
         clickup_list_id = excluded.clickup_list_id,
         list_name = excluded.list_name,
         name = excluded.name,
         status_raw = excluded.status_raw,
         bucket = excluded.bucket,
         rag = excluded.rag,
         progress_pct = excluded.progress_pct,
         type_of_work = excluded.type_of_work,
         client_visible = excluded.client_visible,
         assignee_names = excluded.assignee_names,
         start_date = excluded.start_date,
         due_date = excluded.due_date,
         closed_at = excluded.closed_at,
         url = excluded.url,
         synced_at = now()`,
      [
        t.tenantId, t.clickupTaskId, t.source, t.sprintId, t.clickupListId, t.listName,
        t.name, t.statusRaw, t.bucket, t.rag, t.progressPct, t.typeOfWork, t.clientVisible,
        t.assigneeNames, t.startDate, t.dueDate, t.closedAt, t.url,
      ],
    );
  },

  // ---- sync_runs bookkeeping ----

  async startRun(entity: string, tenantId: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into portal.sync_runs (entity, tenant_id, status) values ($1, $2, 'success')
       returning id`,
      [entity, tenantId],
    );
    return rows[0]!.id;
  },

  async finishRun(
    id: string,
    status: 'success' | 'partial' | 'error',
    recordsUpserted: number,
    errorDetail?: string,
  ): Promise<void> {
    await pool.query(
      `update portal.sync_runs
          set status = $2::portal.sync_status, records_upserted = $3,
              error_detail = $4, finished_at = now()
        where id = $1`,
      [id, status, recordsUpserted, errorDetail ?? null],
    );
  },
};
