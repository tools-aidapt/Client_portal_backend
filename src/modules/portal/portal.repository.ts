import { pool } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';

const TASK_COLUMNS = `clickup_task_id, name, bucket, status_raw, rag, progress_pct,
  type_of_work, assignee_names, start_date, due_date, url, list_name`;

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
  /** Client-visible delivery tasks (Project Progress). */
  async deliveryTasks(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select ${TASK_COLUMNS}
         from portal.task_cache
        where tenant_id = $1 and source = 'delivery' and client_visible = true
        order by due_date nulls last, name`,
      [tenantId],
    );
    return rows;
  },

  async activeSprint(): Promise<{ id: string; name: string; starts_on: string | null; ends_on: string | null } | null> {
    const { rows } = await pool.query(
      `select id, name, starts_on, ends_on from portal.sprints
        where is_active = true order by starts_on desc nulls last limit 1`,
    );
    return (rows[0] as { id: string; name: string; starts_on: string | null; ends_on: string | null }) ?? null;
  },

  /** Client-visible tasks on a given sprint for a tenant (Sprint Line). */
  async sprintTasks(tenantId: string, sprintId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select ${TASK_COLUMNS}
         from portal.task_cache
        where tenant_id = $1 and source = 'sprint' and sprint_id = $2 and client_visible = true
        order by due_date nulls last, name`,
      [tenantId, sprintId],
    );
    return rows;
  },

  /** Tasks on the tenant's onboarding-purpose list (Process Onboarding). */
  async onboardingTasks(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select ${TASK_COLUMNS}
         from portal.task_cache tc
         join portal.clickup_list_mappings m
           on m.tenant_id = tc.tenant_id and m.clickup_list_id = tc.clickup_list_id
        where tc.tenant_id = $1 and m.purpose = 'onboarding'
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
