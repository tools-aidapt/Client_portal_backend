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

  await pool.query(
    `update core.tenants set status = 'active' where id = $1 and status = 'onboarding'`,
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
