import type { PoolClient } from 'pg';
import { pool } from '@infra/db/pool.js';
import type { OnboardingStepDetail } from './types.js';
import type { OnboardingStepKey, OutboxEventType } from '../types/onboarding.types.js';

/**
 * Data-access for client onboarding. Every write method takes the transaction
 * `client` so the whole registration commits atomically. Read methods used
 * outside a transaction accept the pool.
 */
export const onboardingRepo = {
  async slugExists(client: PoolClient, slug: string): Promise<boolean> {
    const { rowCount } = await client.query('select 1 from core.tenants where slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  },

  async insertTenant(
    client: PoolClient,
    t: {
      name: string;
      slug: string;
      productTier?: string;
      clickupFolderId?: string;
      clickupClientGroup?: string;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into core.tenants (name, slug, status, product_tier, clickup_folder_id, clickup_client_group)
       values ($1, $2, 'onboarding', $3, $4, $5)
       returning id`,
      [t.name, t.slug, t.productTier ?? null, t.clickupFolderId ?? null, t.clickupClientGroup ?? null],
    );
    return rows[0]!.id;
  },

  /** Copy the global (tenant_id is null) status map into per-tenant rows. */
  async seedStatusMap(client: PoolClient, tenantId: string): Promise<number> {
    const { rowCount } = await client.query(
      `insert into portal.clickup_status_map (tenant_id, raw_status, bucket, sort_order)
       select $1, raw_status, bucket, sort_order
       from portal.clickup_status_map
       where tenant_id is null
       on conflict (tenant_id, raw_status) do nothing`,
      [tenantId],
    );
    return rowCount ?? 0;
  },

  async insertEmailDomains(
    client: PoolClient,
    tenantId: string,
    domains: string[],
  ): Promise<void> {
    await client.query(
      `insert into core.tenant_email_domains (tenant_id, domain, default_role, auto_join)
       select $1, unnest($2::text[]), 'member', true
       on conflict (domain) do nothing`,
      [tenantId, domains],
    );
  },

  async insertPodPlaceholders(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `insert into portal.pod_members (tenant_id, display_name, role_label, sort_order, is_active)
       values
         ($1, 'To be assigned', 'Pod Lead', 0, false),
         ($1, 'To be assigned', 'AI Engineer', 1, false),
         ($1, 'To be assigned', 'AI Implementation', 2, false)`,
      [tenantId],
    );
  },

  async insertSigmaEmbed(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `insert into portal.sigma_embeds (tenant_id, embed_name, sigma_workbook_id, embed_type, is_active)
       values ($1, 'ROI Overview', 'PENDING', 'roi', false)`,
      [tenantId],
    );
  },

  async insertSupportDefaults(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `insert into support.categories (tenant_id, name, sla_hours) values
         ($1, 'General', 24),
         ($1, 'Technical', 8),
         ($1, 'Billing', 48)`,
      [tenantId],
    );
    await client.query(
      `insert into support.tenant_support_summary (tenant_id) values ($1)
       on conflict (tenant_id) do nothing`,
      [tenantId],
    );
  },

  async insertAdminInvitation(
    client: PoolClient,
    tenantId: string,
    email: string,
    invitedBy: string | null,
  ): Promise<{ id: string; token: string }> {
    // The first client contact becomes the org admin, who can then invite their team.
    const { rows } = await client.query<{ id: string; token: string }>(
      `insert into core.invitations (tenant_id, email, role, invited_by)
       values ($1, $2, 'admin', $3)
       returning id, token`,
      [tenantId, email, invitedBy],
    );
    return rows[0]!;
  },

  async openFirstVotingCycle(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `insert into portal.voting_cycles (tenant_id, period_month, opens_at, closes_at, is_open)
       values (
         $1,
         date_trunc('month', now())::date,
         now(),
         date_trunc('month', now()) + interval '1 month',
         true
       )
       on conflict (tenant_id, period_month) do nothing`,
      [tenantId],
    );
  },

  async insertOnboarding(
    client: PoolClient,
    tenantId: string,
    startedBy: string | null,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into core.client_onboarding (tenant_id, state, started_by)
       values ($1, 'in_progress', $2)
       returning id`,
      [tenantId, startedBy],
    );
    return rows[0]!.id;
  },

  async insertStep(
    client: PoolClient,
    onboardingId: string,
    stepKey: OnboardingStepKey,
    sequence: number,
    status: 'done' | 'failed' | 'skipped',
    detail?: OnboardingStepDetail,
  ): Promise<void> {
    await client.query(
      `insert into core.onboarding_steps (onboarding_id, step_key, sequence, status, detail, attempts)
       values ($1, $2, $3, $4::core.step_status, $5, 1)`,
      [onboardingId, stepKey, sequence, status, detail ? JSON.stringify(detail) : null],
    );
  },

  async enqueueOutbox(
    client: PoolClient,
    e: {
      aggregate?: string;
      aggregateId: string;
      eventType: OutboxEventType;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await client.query(
      `insert into core.outbox (aggregate, aggregate_id, event_type, payload, idempotency_key)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing`,
      [e.aggregate ?? 'onboarding', e.aggregateId, e.eventType, JSON.stringify(e.payload), e.idempotencyKey],
    );
  },

  /** Create a pending invitation for a tenant (used by the admin invite endpoint). */
  async createInvitation(
    client: PoolClient,
    tenantId: string,
    email: string,
    role: string,
    invitedBy: string | null,
  ): Promise<{ id: string; token: string }> {
    const { rows } = await client.query<{ id: string; token: string }>(
      `insert into core.invitations (tenant_id, email, role, invited_by)
       values ($1, $2, $3::core.user_role, $4)
       returning id, token`,
      [tenantId, email, role, invitedBy],
    );
    return rows[0]!;
  },

  // ---- Reads (admin observability) ----

  async listTenants(): Promise<unknown[]> {
    const { rows } = await pool.query(
      `select t.id, t.name, t.slug, t.status, t.product_tier, t.created_at,
              o.state as onboarding_state
       from core.tenants t
       left join core.client_onboarding o on o.tenant_id = t.id
       order by t.created_at desc`,
    );
    return rows;
  },

  async updateClickupMapping(
    tenantId: string,
    fields: {
      clickup_folder_id?: string;
      clickup_client_group?: string;
      clickup_reports_folder_id?: string;
    },
  ): Promise<unknown | null> {
    const { rows } = await pool.query(
      `update core.tenants set
         clickup_folder_id = coalesce($2, clickup_folder_id),
         clickup_client_group = coalesce($3, clickup_client_group),
         clickup_reports_folder_id = coalesce($4, clickup_reports_folder_id),
         updated_at = now()
       where id = $1
       returning id, name, clickup_folder_id, clickup_client_group,
                 clickup_reports_folder_id`,
      [
        tenantId,
        fields.clickup_folder_id ?? null,
        fields.clickup_client_group ?? null,
        fields.clickup_reports_folder_id ?? null,
      ],
    );
    return rows[0] ?? null;
  },

  async getOnboarding(tenantId: string): Promise<unknown | null> {
    const { rows } = await pool.query(
      `select o.id, o.state, o.started_at, o.completed_at,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'step_key', s.step_key, 'status', s.status, 'sequence', s.sequence,
                    'attempts', s.attempts, 'detail', s.detail, 'updated_at', s.updated_at
                  ) order by s.sequence
                ) filter (where s.id is not null), '[]'::jsonb
              ) as steps,
              coalesce(
                (select jsonb_agg(jsonb_build_object(
                    'event_type', x.event_type, 'status', x.status, 'attempts', x.attempts,
                    'last_error', x.last_error, 'next_attempt_at', x.next_attempt_at
                  ))
                 from core.outbox x
                 where x.aggregate = 'onboarding' and x.aggregate_id = o.id), '[]'::jsonb
              ) as outbox
       from core.client_onboarding o
       left join core.onboarding_steps s on s.onboarding_id = o.id
       where o.tenant_id = $1
       group by o.id`,
      [tenantId],
    );
    return rows[0] ?? null;
  },
};
