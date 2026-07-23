import { pool, withTransaction } from '@infra/db/pool.js';

export interface CreateDraftInput {
  tenantId: string;
  sprintId: string | null;
  title: string;
  periodStart: string;
  periodEnd: string;
  summaryMd: string | null;
  committedCount: number | null;
  deliveredCount: number | null;
}

export const reportsRepo = {
  /** Published + archived reports for a tenant (clients never see drafts). */
  async listForClient(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select id, sprint_id, title, period_start, period_end,
              committed_count, delivered_count, status, published_at
         from portal.reports
        where tenant_id = $1 and status in ('published','archived')
        order by published_at desc nulls last, period_end desc`,
      [tenantId],
    );
    return rows;
  },

  /** One published/archived report for a tenant, plus the caller's own pulse. */
  async getForClient(tenantId: string, id: string, userId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(
      `select r.id, r.sprint_id, r.title, r.period_start, r.period_end, r.summary_md,
              r.committed_count, r.delivered_count, r.status, r.published_at,
              (select jsonb_build_object('score', p.score, 'comment', p.comment)
                 from portal.sprint_pulse p where p.report_id = r.id and p.user_id = $3) as my_pulse
         from portal.reports r
        where r.id = $2 and r.tenant_id = $1 and r.status in ('published','archived')`,
      [tenantId, id, userId],
    );
    return rows[0] ?? null;
  },

  /** Raw report row (for admin/publish/pulse validation). */
  async getById(id: string): Promise<{ id: string; tenant_id: string; sprint_id: string | null; status: string } | null> {
    const { rows } = await pool.query(
      `select id, tenant_id, sprint_id, status from portal.reports where id = $1`,
      [id],
    );
    return (rows[0] as { id: string; tenant_id: string; sprint_id: string | null; status: string }) ?? null;
  },

  async getSprintMeta(sprintId: string): Promise<{ name: string; starts_on: string | null; ends_on: string | null } | null> {
    const { rows } = await pool.query(
      `select name, starts_on, ends_on from portal.sprints where id = $1`,
      [sprintId],
    );
    return (rows[0] as { name: string; starts_on: string | null; ends_on: string | null }) ?? null;
  },

  /** Committed/delivered counts from the sprint task cache. */
  async sprintCounts(tenantId: string, sprintId: string): Promise<{ committed: number; delivered: number }> {
    const { rows } = await pool.query<{ committed: number; delivered: number }>(
      `select count(*)::int committed,
              count(*) filter (where bucket = 'delivered')::int delivered
         from portal.task_cache
        where tenant_id = $1 and sprint_id = $2 and source = 'sprint'`,
      [tenantId, sprintId],
    );
    return rows[0]!;
  },

  async createDraft(input: CreateDraftInput): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `insert into portal.reports
         (tenant_id, sprint_id, title, period_start, period_end, summary_md,
          committed_count, delivered_count, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'draft')
       returning id, tenant_id, sprint_id, title, period_start, period_end,
                 summary_md, committed_count, delivered_count, status, created_at`,
      [
        input.tenantId, input.sprintId, input.title, input.periodStart, input.periodEnd,
        input.summaryMd, input.committedCount, input.deliveredCount,
      ],
    );
    return rows[0]!;
  },

  /**
   * Publish a draft: archive the tenant's currently-published reports, mark this
   * one published, and notify MemberPro users. Returns the published row.
   */
  async publish(id: string, publishedBy: string): Promise<Record<string, unknown> | null> {
    return withTransaction(async (client) => {
      const { rows: cur } = await client.query<{ tenant_id: string; status: string }>(
        `select tenant_id, status from portal.reports where id = $1 for update`,
        [id],
      );
      const report = cur[0];
      if (!report) return null;
      if (report.status === 'published') return { alreadyPublished: true };

      await client.query(
        `update portal.reports set status = 'archived'
          where tenant_id = $1 and status = 'published' and id <> $2`,
        [report.tenant_id, id],
      );

      const { rows } = await client.query(
        `update portal.reports
            set status = 'published', published_at = now(), published_by = $2
          where id = $1
          returning id, tenant_id, title, status, published_at`,
        [id, publishedBy],
      );

      // Reports are a MemberPro capability — notify those users.
      await client.query(
        `insert into core.notifications (tenant_id, user_id, type, title, link_url)
         select $1, m.user_id, 'report_published'::core.notification_type,
                'A new report has been published', $2::text
           from core.memberships m
          where m.tenant_id = $1 and m.status = 'active' and m.role = 'member_pro'`,
        [report.tenant_id, `/reports/${id}`],
      );

      return rows[0]!;
    });
  },

  /** Upsert the caller's pulse for a report (one per report per user). */
  async upsertPulse(
    reportId: string,
    userId: string,
    score: number,
    comment: string | null,
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `insert into portal.sprint_pulse (tenant_id, report_id, sprint_id, user_id, score, comment)
       select r.tenant_id, r.id, r.sprint_id, $2::uuid, $3::int, $4::text
         from portal.reports r where r.id = $1
       on conflict (report_id, user_id)
       do update set score = excluded.score, comment = excluded.comment
       returning score, comment, created_at`,
      [reportId, userId, score, comment],
    );
    return rows[0]!;
  },
};
