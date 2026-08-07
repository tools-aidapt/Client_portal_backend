import { pool } from '@infra/db/pool.js';
import type { ReportUpsert, TaskBucket, TaskCacheUpsert } from './mapper.js';
import type { UseCaseUpsert } from './usecase-mapper.js';

export const syncRepo = {
  /**
   * Upsert one case study into the tenant-agnostic use case library.
   * `capability` is never written — the source has no capability field (see
   * migration 0022). `is_published` is driven purely by the ClickUp
   * Confidentiality Level, so a study that is reclassified away from 'Public'
   * is withdrawn from the Portal on the next sync.
   */
  async upsertUseCase(u: UseCaseUpsert): Promise<void> {
    await pool.query(
      `insert into portal.use_cases
         (slug, name, description, category, niche, build_type,
          business_function, integration_type, problem, what_gets_built,
          connects_to, definition_of_done, body_md,
          source_list_name, clickup_task_id, is_published, synced_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), now())
       on conflict (clickup_task_id) do update set
         name               = excluded.name,
         description        = excluded.description,
         category           = excluded.category,
         niche              = excluded.niche,
         build_type         = excluded.build_type,
         business_function  = excluded.business_function,
         integration_type   = excluded.integration_type,
         problem            = excluded.problem,
         what_gets_built    = excluded.what_gets_built,
         connects_to        = excluded.connects_to,
         definition_of_done = excluded.definition_of_done,
         body_md            = excluded.body_md,
         source_list_name   = excluded.source_list_name,
         is_published       = excluded.is_published,
         synced_at          = now(),
         updated_at         = now()`,
      [
        u.slug,
        u.name,
        u.description,
        u.category,
        u.niche,
        u.buildType,
        u.businessFunction,
        u.integrationType,
        u.problem,
        u.whatGetsBuilt,
        u.connectsTo,
        u.definitionOfDone,
        u.bodyMd,
        u.sourceListName,
        u.clickupTaskId,
        u.isPublished,
      ],
    );
  },

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

  /**
   * Un-register a list that was previously mapped as a project but isn't one
   * (see `isProjectList`). Drops its cached tasks and the mapping itself, so
   * the Projects page and its counts stop counting delivery-ops furniture.
   * Only touches `purpose='project'` rows — the shared onboarding mapping and
   * anything else keyed to this list are left alone.
   */
  async retireProject(tenantId: string, listId: string): Promise<void> {
    await pool.query(
      `delete from portal.task_cache
        where tenant_id = $1 and clickup_list_id = $2 and source = 'delivery'`,
      [tenantId, listId],
    );
    await pool.query(
      `delete from portal.clickup_list_mappings
        where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'`,
      [tenantId, listId],
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

  /**
   * Active project list ids mapped for a tenant — every list whose whole
   * contents belong to this one client.
   *
   * `purpose = 'onboarding'` is deliberately NOT included. That mapping points
   * at the shared "ORG - Client - Process List", which holds one task per client
   * engagement across the whole workspace; `syncDelivery` ingests a list wholesale
   * under one tenant, so including it filed every other client's engagement under
   * whichever tenant synced last. That list is only ever ingested by
   * `syncOnboardingRequests`, which routes each task by its "Client Group".
   */
  async getDeliveryListIds(tenantId: string): Promise<string[]> {
    const { rows } = await pool.query<{ clickup_list_id: string }>(
      `select clickup_list_id from portal.clickup_list_mappings
        where tenant_id = $1 and is_active = true and purpose = 'project'`,
      [tenantId],
    );
    return rows.map((r) => r.clickup_list_id);
  },

  /**
   * What a ClickUp list is mapped as, for ANY tenant ('project', 'onboarding',
   * …), or null if no tenant has mapped it. Used by the space walk to tell a
   * client-owned project list from a shared cross-tenant one before it ingests
   * the whole list under a single tenant.
   */
  async getListPurpose(listId: string): Promise<string | null> {
    const { rows } = await pool.query<{ purpose: string }>(
      `select purpose from portal.clickup_list_mappings where clickup_list_id = $1 limit 1`,
      [listId],
    );
    return rows[0]?.purpose ?? null;
  },

  async resolveTenantByClientGroup(group: string): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from core.tenants where clickup_client_group = $1 limit 1`,
      [group],
    );
    return rows[0]?.id ?? null;
  },

  /**
   * A profile id for an email, but only if that person is a member of this
   * tenant. Scoped through `core.memberships` on purpose: the wishlist intake
   * form is a public form, so the address it captures is untrusted input, and
   * matching it against `core.profiles` alone would let a submission be
   * attributed to a user in a different client's tenant.
   */
  async resolveTenantProfileByEmail(tenantId: string, email: string): Promise<string | null> {
    // Email lives on core.user_credentials, not core.profiles (migration 0014
    // moved auth in-house and profiles carries no address of its own).
    const { rows } = await pool.query<{ id: string }>(
      `select c.user_id as id
         from core.user_credentials c
         join core.memberships m
           on m.user_id = c.user_id and m.tenant_id = $1 and m.status = 'active'
        where lower(c.email) = lower($2)
        limit 1`,
      [tenantId, email],
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
          name, display_title, status_raw, bucket, rag, progress_pct, type_of_work,
          parent_task_id, client_visible, assignee_names, start_date, due_date,
          closed_at, url, synced_at)
       values ($1,$2,$3::portal.task_source,$4,$5,$6,$7,$8,$9,$10::portal.task_bucket,
               $11::portal.rag_status,$12,$13,$14,$15,$16::text[],$17,$18,$19,$20, now())
       on conflict (clickup_task_id) do update set
         tenant_id = excluded.tenant_id,
         source = excluded.source,
         sprint_id = excluded.sprint_id,
         clickup_list_id = excluded.clickup_list_id,
         list_name = excluded.list_name,
         name = excluded.name,
         display_title = excluded.display_title,
         status_raw = excluded.status_raw,
         bucket = excluded.bucket,
         rag = excluded.rag,
         progress_pct = excluded.progress_pct,
         type_of_work = excluded.type_of_work,
         parent_task_id = excluded.parent_task_id,
         client_visible = excluded.client_visible,
         assignee_names = excluded.assignee_names,
         start_date = excluded.start_date,
         due_date = excluded.due_date,
         closed_at = excluded.closed_at,
         url = excluded.url,
         synced_at = now()`,
      [
        t.tenantId, t.clickupTaskId, t.source, t.sprintId, t.clickupListId, t.listName,
        t.name, t.displayTitle, t.statusRaw, t.bucket, t.rag, t.progressPct, t.typeOfWork,
        t.parentTaskId, t.clientVisible, t.assigneeNames, t.startDate, t.dueDate, t.closedAt, t.url,
      ],
    );
  },

  /**
   * Idempotent upsert of one report Doc page, keyed by clickup_page_id.
   * Portal-native reports leave that column null (partial unique index,
   * migration 0021) and are never touched by this. `published_by` stays null:
   * these were published in ClickUp, not by a portal admin.
   */
  async upsertReportFromDoc(r: ReportUpsert): Promise<void> {
    await pool.query(
      `insert into portal.reports
         (tenant_id, clickup_doc_id, clickup_page_id, title, period_start, period_end,
          summary_md, committed_count, delivered_count, status, published_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published'::portal.report_status,$10)
       on conflict (clickup_page_id) where clickup_page_id is not null
       do update set
         tenant_id = excluded.tenant_id,
         clickup_doc_id = excluded.clickup_doc_id,
         title = excluded.title,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         summary_md = excluded.summary_md,
         committed_count = excluded.committed_count,
         delivered_count = excluded.delivered_count,
         published_at = excluded.published_at`,
      [
        r.tenantId, r.clickupDocId, r.clickupPageId, r.title, r.periodStart, r.periodEnd,
        r.summaryMd, r.committedCount, r.deliveredCount, r.publishedAt,
      ],
    );
  },

  /**
   * Keep the tenant's "one published report at a time" invariant (the same one
   * `reportsRepo.publish` maintains): the latest synced report stays published,
   * every older one is archived. Clients still see both — `listForClient`
   * returns published + archived — so nothing disappears. Scoped to synced rows
   * so a portal-native published report is left alone.
   */
  async archiveSupersededSyncedReports(tenantId: string, docId: string): Promise<number> {
    const { rowCount } = await pool.query(
      `update portal.reports set status = 'archived'
        where tenant_id = $1 and clickup_doc_id = $2 and status = 'published'
          and period_end < (select max(period_end) from portal.reports
                             where tenant_id = $1 and clickup_doc_id = $2)`,
      [tenantId, docId],
    );
    return rowCount ?? 0;
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
