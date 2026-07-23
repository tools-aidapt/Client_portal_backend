/* Throwaway end-to-end check of the onboarding orchestration + outbox worker
 * against the live database. Registers a client, drains the outbox, asserts the
 * tenant finalizes to `active`, then deletes everything it created.
 *
 * Run: npx tsx scripts/smoke-onboarding.ts
 */
import { onboardingService } from '@modules/admin/clients/services/onboarding.service.js';
import { onboardingRepo } from '@modules/admin/clients/repositories/onboarding.repository.js';
import { drainOnce } from '@modules/outbox/worker.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();
const name = `Smoke Test Co ${stamp}`;
const domain = `smoke-${stamp}.example`;

async function main() {
  const result = await onboardingService.register(
    {
      name,
      emailDomains: [domain],
      productTier: 'Pilot',
      clickupClientGroup: 'Smoke Group',
      adminEmail: `admin@${domain}`,
      sigmaReady: true,
    },
    null,
  );
  console.log('registered:', result);

  const before = (await onboardingRepo.getOnboarding(result.tenantId)) as any;
  console.log('state before drain:', before.state, '| steps:', before.steps.length,
    '| outbox:', before.outbox.map((o: any) => `${o.event_type}=${o.status}`).join(', '));

  const summary = await drainOnce();
  console.log('drain summary:', summary);

  const after = (await onboardingRepo.getOnboarding(result.tenantId)) as any;
  const { rows: t } = await pool.query('select status from core.tenants where id=$1', [result.tenantId]);
  console.log('state after drain:', after.state, '| tenant status:', t[0]?.status,
    '| outbox:', after.outbox.map((o: any) => `${o.event_type}=${o.status}`).join(', '));

  const pass = after.state === 'completed' && t[0]?.status === 'active';
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  // Cleanup. outbox has no FK to onboarding and audit_log restricts tenant
  // deletes, so remove both before the tenant. Sweep any leftovers from prior runs.
  await pool.query(`delete from core.outbox where aggregate_id=$1`, [result.onboardingId]);
  await pool.query(`delete from core.audit_log where tenant_id in (select id from core.tenants where name like 'Smoke Test Co %')`);
  const del = await pool.query(`delete from core.tenants where name like 'Smoke Test Co %'`);
  console.log(`cleaned up ${del.rowCount} test tenant(s)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
