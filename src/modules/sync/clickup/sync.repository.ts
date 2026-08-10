import { pool, type Queryable } from '@infra/db/pool.js';
import type { TaskBucket, TaskCacheUpsert } from './mapper.js';
import type { ReportDocUpsert, ReportSectionUpsert } from './report-mapper.js';
import type { UseCaseUpsert } from './usecase-mapper.js';

export const syncRepo = {
  /**
   * Upsert one case study into the tenant-agnostic use case library.
   * `capability` is never written — the source has no capability field (see
   * migration 0022). `is_published` comes straight from the mapper, which
   * publishes everything except studies explicitly marked `NDA-required` or
   * `Internal-only` in ClickUp — so re-marking one there withdraws it on the
   * next sync.
   */
  async upsertUseCase(u: UseCaseUpsert): Promise<void> {
    await pool.query(
      `insert into portal.use_cases
         (slug, name, description, category, niche, build_type,
          business_function, integration_type, problem, solution,
          connects_to, impact, body_md,
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
         solution    = excluded.solution,
         connects_to        = excluded.connects_to,
         impact = excluded.impact,
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
        u.solution,
        u.connectsTo,
        u.impact,
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
   * Upsert one monthly report Doc, keyed by `clickup_doc_id`.
   *
   * Keyed on the DOC and not the root page: deleting and recreating a Doc's root
   * page in ClickUp changes the page id but not the doc id, and a page-keyed
   * upsert would insert a SECOND report for the same month instead of updating
   * the one already there.
   *
   * `status` IS written, unlike the old bi-weekly upsert — an empty Doc has to
   * be able to promote itself from draft to published once someone fills it in.
   * `published_by` stays null: these are published in ClickUp, not by an admin.
   * Portal-native reports leave `clickup_doc_id` null and are never touched.
   */
  async upsertReportFromDoc(client: Queryable, r: ReportDocUpsert): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into portal.reports
         (tenant_id, clickup_doc_id, clickup_page_id, title, period_start, period_end,
          summary_md, committed_count, delivered_count, status, published_at,
          doc_updated_at, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::portal.report_status,$11,$12, now())
       on conflict (clickup_doc_id) where clickup_doc_id is not null
       do update set
         tenant_id = excluded.tenant_id,
         clickup_page_id = excluded.clickup_page_id,
         title = excluded.title,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         summary_md = excluded.summary_md,
         committed_count = excluded.committed_count,
         delivered_count = excluded.delivered_count,
         status = excluded.status,
         published_at = excluded.published_at,
         doc_updated_at = excluded.doc_updated_at,
         synced_at = now()
       returning id`,
      [
        r.tenantId, r.clickupDocId, r.clickupPageId, r.title, r.periodStart, r.periodEnd,
        r.summaryMd, r.committedCount, r.deliveredCount, r.status, r.publishedAt,
        r.docUpdatedAt,
      ],
    );
    return rows[0]!.id;
  },

  /** Upsert one pillar section, keyed by its ClickUp page id. */
  async upsertReportSection(
    client: Queryable,
    reportId: string,
    tenantId: string,
    s: ReportSectionUpsert,
  ): Promise<void> {
    await client.query(
      `insert into portal.report_sections
         (report_id, tenant_id, clickup_page_id, pillar, pillar_label, pillar_owner,
          subtitle, body_md, committed_count, delivered_count, sort_order, synced_at)
       values ($1,$2,$3,$4::portal.capability,$5,$6,$7,$8,$9,$10,$11, now())
       on conflict (clickup_page_id) do update set
         report_id = excluded.report_id,
         tenant_id = excluded.tenant_id,
         pillar = excluded.pillar,
         pillar_label = excluded.pillar_label,
         pillar_owner = excluded.pillar_owner,
         subtitle = excluded.subtitle,
         body_md = excluded.body_md,
         committed_count = excluded.committed_count,
         delivered_count = excluded.delivered_count,
         sort_order = excluded.sort_order,
         synced_at = now()`,
      [
        reportId, tenantId, s.clickupPageId, s.pillar, s.pillarLabel, s.pillarOwner,
        s.subtitle, s.bodyMd, s.committedCount, s.deliveredCount, s.sortOrder,
      ],
    );
  },

  /**
   * Drop sections whose ClickUp page is gone from the Doc.
   *
   * Sections are upserted rather than wiped-and-reinserted so their uuids stay
   * stable across the hourly run; this is the other half of that — a pillar page
   * deleted in ClickUp has to stop being rendered.
   */
  async deleteOrphanSections(client: Queryable, reportId: string, keepPageIds: string[]): Promise<number> {
    const { rowCount } = await client.query(
      `delete from portal.report_sections
        where report_id = $1 and clickup_page_id <> all($2::text[])`,
      [reportId, keepPageIds],
    );
    return rowCount ?? 0;
  },

  /** Tenants with a Monthly Progress Reports folder mapped. */
  async listReportsFolderTenants(
    tenantId?: string,
  ): Promise<Array<{ id: string; folderId: string; name: string }>> {
    const { rows } = await pool.query<{ id: string; folder_id: string; name: string }>(
      `select id, clickup_reports_folder_id as folder_id, name
         from core.tenants
        where clickup_reports_folder_id is not null
          and ($1::uuid is null or id = $1::uuid)
        order by name`,
      [tenantId ?? null],
    );
    return rows.map((r) => ({ id: r.id, folderId: r.folder_id, name: r.name }));
  },

  /**
   * Whether the tenant has a portal-native published report (created and
   * published by an admin rather than synced). When one exists the sync leaves
   * it alone instead of overriding it, which otherwise ping-pongs hourly:
   * `reportsRepo.publish` archives the synced row, the next sync re-publishes it
   * and archives the native one, forever.
   */
  async hasNativePublishedReport(tenantId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `select 1 from portal.reports
        where tenant_id = $1 and clickup_doc_id is null and status = 'published' limit 1`,
      [tenantId],
    );
    return rows.length > 0;
  },

  /**
   * Withdraw synced reports whose Doc is gone from the client's folder — deleted,
   * moved, or no longer recognised as a monthly report.
   *
   * Set back to `draft`, not `archived`. Archived means "an older month, still
   * worth reading" and stays visible to the client; a report whose source has
   * gone is not history, it is a mistake being cleaned up, and it should
   * disappear. Draft is the only status the read queries hide.
   *
   * Never deleted: `portal.sprint_pulse` cascades, and a client's rating is not
   * something a sync should be able to destroy. The caller only invokes this
   * after a clean, non-empty listing — doing it after a partial fetch would
   * withdraw every report the failed call didn't return.
   */
  async retireMissingSyncedReports(tenantId: string, seenDocIds: string[]): Promise<number> {
    if (seenDocIds.length === 0) return 0;
    const { rowCount } = await pool.query(
      `update portal.reports set status = 'draft'
        where tenant_id = $1 and clickup_doc_id is not null
          and status <> 'draft' and clickup_doc_id <> all($2::text[])`,
      [tenantId, seenDocIds],
    );
    return rowCount ?? 0;
  },

  /**
   * Keep the tenant's "one published report at a time" invariant (the same one
   * `reportsRepo.publish` maintains): the latest synced report stays published,
   * every older one is archived. Clients still see both — `listForClient`
   * returns published + archived — so nothing disappears. Scoped to synced rows
   * so a portal-native published report is left alone.
   *
   * Scoped to the TENANT, not to one Doc: a client now has one Doc per month, so
   * per-doc scoping would leave every month simultaneously published.
   *
   * The `doc_updated_at` tiebreak is load-bearing. Kenafric currently has two
   * Docs for July 2026 (a legacy duplicate alongside the real one) with the same
   * `period_end`, and without a stable secondary sort the "current" report would
   * alternate between runs — which, because `notifyPublishedReport` keys its
   * idempotency guard on the report's own link, would fire a fresh notification
   * on every single run.
   *
   * Never touches drafts, so an empty Doc stays hidden rather than being
   * promoted by the sweep.
   */
  async archiveSupersededSyncedReports(tenantId: string): Promise<number> {
    const { rowCount } = await pool.query(
      `update portal.reports set status = 'archived'
        where tenant_id = $1 and clickup_doc_id is not null and status = 'published'
          and id <> (
            select id from portal.reports
             where tenant_id = $1 and clickup_doc_id is not null and status = 'published'
             order by period_end desc, doc_updated_at desc nulls last, clickup_doc_id desc
             limit 1)`,
      [tenantId],
    );
    return rowCount ?? 0;
  },

  /**
   * Notify a tenant's MemberPro users about their CURRENT published report.
   *
   * Reports that arrive by sync never produced a notification, so a client
   * could have a published report and an empty activity feed: only
   * `reportsRepo.publish` emits, and synced rows go in through
   * `upsertReportFromDoc` instead (which is why all 9 of Kenafric's reports
   * have `published_by = null`). This closes that gap for the sync path.
   *
   * Three properties make it safe to call on every sync run:
   *
   * - **Only the newest report notifies.** It reads the one row still
   *   `published` after `archiveSupersededSyncedReports` has run, using the SAME
   *   ordering — the two must agree, or this announces the report the other one
   *   just archived. So a client's first-ever sync announces the latest month
   *   once instead of firing one notification per backfilled month.
   * - **Once per user per report, ever.** The `not exists` guard keys on the
   *   report's own `link_url`, so a re-sync inserts nothing. That is what makes
   *   it idempotent without a "notified_at" column, and it dedupes against
   *   `reportsRepo.publish` too, since both paths write the same
   *   `/reports/:id` link.
   * - **It backfills.** A report that was synced before this existed still
   *   notifies on the next run, because the guard finds no notification for it.
   *
   * MemberPro is the role gate because that is who can read Reports at all
   * (`reportsRoutes`) — notifying a member who would get a 403 on the link is
   * worse than staying quiet.
   */
  async notifyPublishedReport(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `select id from portal.reports
        where tenant_id = $1 and clickup_doc_id is not null and status = 'published'
        order by period_end desc, doc_updated_at desc nulls last, clickup_doc_id desc
        limit 1`,
      [tenantId],
    );
    const report = rows[0];
    if (!report) return 0;

    const { rowCount } = await pool.query(
      `insert into core.notifications (tenant_id, user_id, type, title, link_url)
       select $1, m.user_id, 'report_published'::core.notification_type,
              'A new report has been published', $2::text
         from core.memberships m
        where m.tenant_id = $1 and m.status = 'active' and m.role in ('admin','super_admin')
          and not exists (
            select 1 from core.notifications n
             where n.user_id = m.user_id and n.link_url = $2::text
               and n.type = 'report_published'::core.notification_type
          )`,
      [tenantId, `/reports/${report.id}`],
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
