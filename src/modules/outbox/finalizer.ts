import { pool } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';

/**
 * When every outbox event for an onboarding aggregate has completed, flip the
 * onboarding to `completed` and the tenant to `active`, and record an audit row
 * (design §9.2 finalizer).
 */
export async function finalizeOnboarding(onboardingId: string): Promise<void> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `update core.client_onboarding
        set state = 'completed', completed_at = now()
      where id = $1 and state <> 'completed'
      returning tenant_id`,
    [onboardingId],
  );
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) return; // already finalized or unknown

  // A client can be suspended while its onboarding is still running, and this
  // used to be a plain `status = 'active' where status = 'onboarding'`: on a
  // suspended tenant the WHERE simply missed, so the suspension survived but
  // the tenant was left remembering 'onboarding' as the status to restore —
  // and resuming would have silently rewound a finished onboarding. So the
  // completion is recorded where it will actually be read: on the live status
  // when the tenant is running, and on the status queued for restore when it
  // is suspended. Both arms of the CASE read the value from BEFORE this
  // update, which is what makes the pair coherent.
  await pool.query(
    `update core.tenants
        set status = case when status = 'suspended'
                          then 'suspended'::core.tenant_status
                          else 'active'::core.tenant_status end,
            status_before_suspension = case when status = 'suspended'
                          then 'active'::core.tenant_status
                          else status_before_suspension end,
            updated_at = now()
      where id = $1
        and (status = 'onboarding'
             or (status = 'suspended' and status_before_suspension = 'onboarding'))`,
    [tenantId],
  );
  await pool.query(
    `insert into core.audit_log (tenant_id, action, target, metadata)
     values ($1, 'onboarding.completed', $2, jsonb_build_object('onboarding_id', $2::text))`,
    [tenantId, onboardingId],
  );
  logger.info({ onboardingId, tenantId }, 'Onboarding finalized — tenant is active');
}

/** Mark the onboarding failed after an outbox event exhausts its retries. */
export async function failOnboarding(onboardingId: string, error: string): Promise<void> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `update core.client_onboarding set state = 'failed'
      where id = $1 and state not in ('completed','failed')
      returning tenant_id`,
    [onboardingId],
  );
  const tenantId = rows[0]?.tenant_id ?? null;
  await pool.query(
    `insert into core.audit_log (tenant_id, action, target, metadata)
     values ($1, 'onboarding.failed', $2, jsonb_build_object('onboarding_id', $2::text, 'error', $3::text))`,
    [tenantId, onboardingId, error],
  );
  logger.error({ onboardingId, error }, 'Onboarding failed — an outbox event is dead');
}
