import { pool } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';

// `clickup_list_id` is required, not decorative: projects() groups tasks by it.
// Leaving it out silently returned an empty task list for every project (and so
// a bogus 'upcoming' status for all of them), because the row-type generic on
// pool.query asserts the shape rather than checking it against the SQL.
//
// Every column is qualified with `tc.` and every query aliases task_cache as
// `tc`: onboardingTasks() joins clickup_list_mappings, which has its OWN
// `clickup_list_id`, so the unqualified list made that one query fail outright
// with `column reference "clickup_list_id" is ambiguous` — GET /onboarding was
// a 500 for every tenant. Qualifying here keeps the three callers in step.
const TASK_COLUMNS = `tc.clickup_task_id, tc.clickup_list_id, tc.parent_task_id, tc.name,
  tc.bucket, tc.status_raw, tc.rag, tc.progress_pct, tc.type_of_work, tc.assignee_names,
  tc.start_date, tc.due_date, tc.url, tc.list_name`;

/** Run a summary query owned by another team; return null if its table is absent. */
async function summaryOrNull(
  sql: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { rows } = await pool.query(sql, [tenantId]);
    return rows[0] ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      logger.warn({ sql }, 'Summary table missing (owned by another team) — tile null');
      return null;
    }
    throw err;
  }
}

export const portalRepo = {
  /**
   * Projects for the client: one row per ClickUp list mapped as `purpose =
   * 'project'` and marked client-visible. Its `tasks` are the project's
   * PHASES — the top-level ClickUp tasks ("1. Current State Discovery" …
   * "7. Training & Handover") — each carrying its own subtasks nested under
   * `subtasks`, exactly how ClickUp's own List view presents them.
   *
   * The sync pulls subtasks (`subtasks=true`), so a flat read here showed a
   * client 159 "tasks" for a 6-phase project. Nesting is done in JS rather than
   * SQL because both levels come from the same single scan of task_cache.
   * A list with no visible tasks yet still appears, empty.
   */
  async projects(tenantId: string): Promise<
    Array<{ clickup_list_id: string; name: string; tasks: Array<Record<string, unknown>> }>
  > {
    const { rows } = await pool.query<{ clickup_list_id: string; display_label: string | null }>(
      `select clickup_list_id, display_label
         from portal.clickup_list_mappings
        where tenant_id = $1 and purpose = 'project' and client_visible = true and is_active = true
        order by display_label`,
      [tenantId],
    );

    type Row = { clickup_list_id: string | null; clickup_task_id: string; parent_task_id: string | null } & Record<
      string,
      unknown
    >;
    // Ordered by name so numbered phases read 1 → 7 as they do in ClickUp.
    const { rows: tasks } = await pool.query<Row>(
      `select ${TASK_COLUMNS}
         from portal.task_cache tc
        where tc.tenant_id = $1 and tc.source = 'delivery' and tc.client_visible = true
        order by tc.name`,
      [tenantId],
    );

    // ClickUp nests subtasks up to 3 deep in this workspace, so "is a phase"
    // means "has no parent among the tasks we can see" — testing only against
    // top-level ids would promote every grandchild to a phase of its own.
    const allIds = new Set(tasks.map((t) => t.clickup_task_id));
    const isPhase = (t: Row) => !t.parent_task_id || !allIds.has(t.parent_task_id);

    const childrenByParent = new Map<string, Row[]>();
    for (const t of tasks) {
      if (isPhase(t)) continue;
      const siblings = childrenByParent.get(t.parent_task_id!);
      if (siblings) siblings.push(t);
      else childrenByParent.set(t.parent_task_id!, [t]);
    }

    const byDueThenName = (a: Row, b: Row) => {
      const ad = (a.due_date as string | null) ?? '';
      const bd = (b.due_date as string | null) ?? '';
      if (ad !== bd) return ad === '' ? 1 : bd === '' ? -1 : ad < bd ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    };

    /** Every descendant of a phase, flattened depth-first and tagged with depth. */
    const descendants = (id: string, depth = 1): Array<Record<string, unknown>> =>
      (childrenByParent.get(id) ?? [])
        .sort(byDueThenName)
        .flatMap((child) => [{ ...child, depth }, ...descendants(child.clickup_task_id, depth + 1)]);

    const phasesByList = new Map<string, Array<Record<string, unknown>>>();
    for (const t of tasks) {
      if (!t.clickup_list_id || !isPhase(t)) continue;
      const subtasks = descendants(t.clickup_task_id);
      const phase = {
        ...t,
        subtasks,
        subtask_total: subtasks.length,
        subtask_done: subtasks.filter((s) => s.bucket === 'delivered').length,
      };
      const list = phasesByList.get(t.clickup_list_id);
      if (list) list.push(phase);
      else phasesByList.set(t.clickup_list_id, [phase]);
    }

    return rows.map((r) => ({
      clickup_list_id: r.clickup_list_id,
      name: r.display_label ?? r.clickup_list_id,
      tasks: phasesByList.get(r.clickup_list_id) ?? [],
    }));
  },

  async activeSprint(): Promise<{ id: string; name: string; starts_on: string | null; ends_on: string | null } | null> {
    const { rows } = await pool.query(
      `select id, name, starts_on, ends_on from portal.sprints
        where is_active = true order by starts_on desc nulls last limit 1`,
    );
    return (rows[0] as { id: string; name: string; starts_on: string | null; ends_on: string | null }) ?? null;
  },

  /**
   * Client-visible tasks falling inside a sprint's date window (Sprint Line).
   *
   * **Scoped by due date, not by `task_cache.sprint_id`.** The obvious read —
   * `source = 'sprint' and sprint_id = $2` — is what this used to do, and it
   * returned zero rows for every tenant, every sprint: that path requires each
   * task to be duplicated onto a per-sprint ClickUp list and routed by "Client
   * Group", and no such list is ever populated in this workspace (Kenafric's
   * only two `source = 'sprint'` rows are `client_visible = false`). The
   * "Sprint Number" custom field was checked as an alternative and is unset on
   * every delivery task. So each delivery task's own `due_date` is the only
   * genuine per-task sprint signal available.
   *
   * The window is inclusive on both ends, matching how `sprints.is_active` is
   * computed (`today` inside `[starts_on, ends_on]`). Both dates are nullable
   * on `sprints`; with either missing there is no window to filter on, and an
   * unbounded range would return the tenant's entire delivery backlog as "this
   * sprint" — so the caller gets `[]` instead.
   *
   * The bounds are typed `string | Date` because node-postgres parses `date`
   * columns into JS `Date`s, so `activeSprint()` hands over Dates despite its
   * own (pre-existing, inaccurate) `string | null` annotation. Both work: the
   * explicit `::date` casts pin the comparison to calendar days, so a Date
   * carrying a local-midnight offset can't be shifted a day by the server's
   * timezone (verified against the live DB — server `UTC`, client `UTC+5`,
   * bounds still resolved to 2026-07-26 / 2026-08-09).
   */
  async sprintTasks(
    tenantId: string,
    startsOn: string | Date | null,
    endsOn: string | Date | null,
  ): Promise<Array<Record<string, unknown>>> {
    if (!startsOn || !endsOn) return [];
    const { rows } = await pool.query(
      `select ${TASK_COLUMNS}
         from portal.task_cache tc
        where tc.tenant_id = $1 and tc.source = 'delivery'
          and tc.client_visible = true
          and tc.due_date between $2::date and $3::date
        order by tc.due_date nulls last, tc.name`,
      [tenantId, startsOn, endsOn],
    );
    return rows;
  },

  /**
   * Tasks on the tenant's onboarding-purpose list (Process Onboarding).
   *
   * Joins out to `wishlist_items` so a task an admin has linked back to a
   * prioritised wishlist item carries the item's **title**, not just its id —
   * the frontend shows "Originated from your Wishlist: …" without a second
   * round-trip. `source_wishlist_title` is null whenever the link is unset,
   * which is the case for all but a handful of rows.
   *
   * The join is `left`, and additionally tenant-scoped: a cross-tenant link
   * can't be created through the admin endpoint, but if one ever existed the
   * title must not leak into another client's response — it would render as
   * unlinked instead.
   *
   * `client_visible` is filtered here as it is on every other client-facing
   * read, and it matters more here than anywhere else: the source list is
   * SHARED across all clients (one task per client engagement), so a row that
   * is cached against the wrong tenant is another client's name. Only
   * `syncOnboardingRequests` — which routes each task by its "Client Group" —
   * sets the flag, so anything a tenant-blanket sync path drops in stays hidden.
   *
   * `display_title` is selected only here: it is the intake form's "Project
   * name" (see migration 0026), which only submissions on this list carry. The
   * frontend prefers it over `name`, since several of a client's submissions
   * are named after the client itself and are otherwise indistinguishable.
   */
  async onboardingTasks(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select ${TASK_COLUMNS}, tc.display_title, tc.source_wishlist_item_id,
              wi.title as source_wishlist_title
         from portal.task_cache tc
         join portal.clickup_list_mappings m
           on m.tenant_id = tc.tenant_id and m.clickup_list_id = tc.clickup_list_id
         left join portal.wishlist_items wi
           on wi.id = tc.source_wishlist_item_id and wi.tenant_id = tc.tenant_id
        where tc.tenant_id = $1 and m.purpose = 'onboarding' and m.is_active = true
          and tc.client_visible = true
        order by tc.due_date nulls last, tc.name`,
      [tenantId],
    );
    return rows;
  },

  async pod(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select display_name, role_label, avatar_url, sort_order
         from portal.pod_members
        where tenant_id = $1 and is_active = true
        order by sort_order, display_name`,
      [tenantId],
    );
    return rows;
  },

  /** Per-bucket delivery counts for the dashboard. */
  async deliveryCounts(tenantId: string): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ bucket: string | null; n: number }>(
      `select bucket, count(*)::int n
         from portal.task_cache
        where tenant_id = $1 and source = 'delivery' and client_visible = true
        group by bucket`,
      [tenantId],
    );
    const out: Record<string, number> = { delivered: 0, in_progress: 0, upcoming: 0 };
    for (const r of rows) if (r.bucket) out[r.bucket] = r.n;
    return out;
  },

  /**
   * LMS tile, computed live from the LMS team's schema. Their data keys to a
   * client group; we bridge from the Portal tenant by email domain:
   *   core.tenant_email_domains.domain -> lms.LMS_client_domains -> client group.
   * Returns null if the tenant maps to no LMS client group (no LMS presence).
   *
   * Wrapped in a 42P01 guard: if the LMS team renames/drops these tables the
   * tile degrades to null rather than breaking the dashboard.
   */
  async enablementSummary(tenantId: string): Promise<Record<string, unknown> | null> {
    try {
      const { rows } = await pool.query<{
        active_learners: number;
        courses_assigned: number;
        avg_completion_pct: string;
        group_count: number;
      }>(
        `with groups as (
           select distinct d.client_group_id as gid
             from core.tenant_email_domains ted
             join lms."LMS_client_domains" d on lower(d.domain) = lower(ted.domain)
            where ted.tenant_id = $1
         )
         select
           (select count(*)::int from lms."LMS_users" u
             where u.client_group_id in (select gid from groups) and u.active) as active_learners,
           (select count(distinct e.course_id)::int from lms."LMS_group_course_entitlements" e
             where e.client_group_id in (select gid from groups)) as courses_assigned,
           coalesce(round(100.0 *
             (select count(*) from lms."LMS_user_course_completion" cc
                join lms."LMS_users" u on u.id = cc.user_id
               where u.client_group_id in (select gid from groups))
             / nullif((select count(*) from lms."LMS_user_course_assignments" a
                join lms."LMS_users" u on u.id = a.user_id
               where u.client_group_id in (select gid from groups)), 0), 2), 0) as avg_completion_pct,
           (select count(*)::int from groups) as group_count
        `,
        [tenantId],
      );
      const r = rows[0];
      if (!r || r.group_count === 0) return null;
      return {
        active_learners: r.active_learners,
        courses_assigned: r.courses_assigned,
        avg_completion_pct: Number(r.avg_completion_pct),
      };
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') {
        logger.warn('LMS tables missing — LMS tile null');
        return null;
      }
      throw err;
    }
  },

  async supportSummary(tenantId: string): Promise<Record<string, unknown> | null> {
    return summaryOrNull(
      `select open_tickets, breached_sla, updated_at
         from support.tenant_support_summary where tenant_id = $1`,
      tenantId,
    );
  },

  async notifications(userId: string, tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select id, type, title, body, link_url, is_read, created_at
         from core.notifications
        where user_id = $1 and tenant_id = $2
        order by created_at desc limit 50`,
      [userId, tenantId],
    );
    return rows;
  },

  async unreadCount(userId: string, tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int n from core.notifications
        where user_id = $1 and tenant_id = $2 and is_read = false`,
      [userId, tenantId],
    );
    return rows[0]!.n;
  },

  /** Mark one notification read; false if it isn't the user's. */
  async markNotificationRead(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `update core.notifications set is_read = true where id = $1 and user_id = $2`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  },
};
