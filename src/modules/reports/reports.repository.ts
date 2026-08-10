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
  /**
   * Published + archived reports for a tenant (clients never see drafts).
   *
   * `pillars` lets the list show what a month covered without shipping three
   * pillar bodies per row. The `created_at, id` tiebreak is not cosmetic: a
   * client can hold two Docs for the same month (a duplicate left in ClickUp),
   * and on equal `published_at`/`period_end` the order would otherwise flip
   * between requests.
   */
  async listForClient(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select r.id, r.sprint_id, r.title, r.period_start, r.period_end,
              r.committed_count, r.delivered_count, r.status, r.published_at,
              coalesce(s.pillars, '{}') as pillars,
              coalesce(s.section_count, 0) as section_count
         from portal.reports r
         left join lateral (
           select array_agg(x.pillar_label order by x.sort_order) as pillars,
                  count(*)::int as section_count
             from portal.report_sections x where x.report_id = r.id
         ) s on true
        where r.tenant_id = $1 and r.status in ('published','archived')
        order by r.published_at desc nulls last, r.period_end desc,
                 r.created_at desc, r.id desc`,
      [tenantId],
    );
    return rows;
  },

  /**
   * One published/archived report for a tenant, plus the caller's own pulse and
   * its pillar sections.
   *
   * `summary_md` is only the Doc's ROOT page (Executive Summary, Pillar Status
   * Snapshot, Consolidated Risks…) — the bulk of a monthly report lives in
   * `sections`, so a caller that renders only `summary_md` silently drops most
   * of it. Sections come back in the same round trip rather than an N+1, the
   * same shape as the `my_pulse` subselect beside them.
   */
  async getForClient(tenantId: string, id: string, userId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(
      `select r.id, r.sprint_id, r.title, r.period_start, r.period_end, r.summary_md,
              r.committed_count, r.delivered_count, r.status, r.published_at,
              (select jsonb_build_object('score', p.score, 'comment', p.comment)
                 from portal.sprint_pulse p where p.report_id = r.id and p.user_id = $3) as my_pulse,
              (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', s.id,
                        'pillar', s.pillar,
                        'pillar_label', s.pillar_label,
                        'pillar_owner', s.pillar_owner,
                        'subtitle', s.subtitle,
                        'body_md', s.body_md,
                        'committed_count', s.committed_count,
                        'delivered_count', s.delivered_count
                      ) order by s.sort_order), '[]'::jsonb)
                 from portal.report_sections s where s.report_id = r.id) as sections
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

  /** Tenant display name, for the PDF masthead. */
  async getTenantName(tenantId: string): Promise<string | null> {
    const { rows } = await pool.query<{ name: string }>(
      `select name from core.tenants where id = $1`,
      [tenantId],
    );
    return rows[0]?.name ?? null;
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
          where m.tenant_id = $1 and m.status = 'active' and m.role in ('admin','super_admin')`,
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
