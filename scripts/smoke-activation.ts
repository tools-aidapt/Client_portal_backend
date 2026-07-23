/* Throwaway end-to-end check of first-user activation (§9.3) against the live
 * database + Supabase Auth. Registers a client, creates a real auth user for the
 * invited email, accepts the invitation, checks /me, then deletes everything.
 *
 * Run: npx tsx scripts/smoke-activation.ts
 */
import { onboardingService } from '@modules/admin/clients/services/onboarding.service.js';
import { authService } from '@modules/auth/services/auth.service.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();
const domain = `smoke-${stamp}.example`;
const email = `admin@${domain}`;

async function main() {
  const reg = await onboardingService.register(
    { name: `Smoke Test Co ${stamp}`, emailDomains: [domain], adminEmail: email, sigmaReady: false },
    null,
  );
  const { rows: inv } = await pool.query<{ token: string }>(
    `select token from core.invitations where tenant_id=$1`,
    [reg.tenantId],
  );
  const token = inv[0]!.token;
  console.log('registered tenant + invitation token issued');

  // Create the invited user via the Supabase Admin API (trigger makes the profile).
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Smoke Admin' },
  });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  const userId = data.user.id;
  console.log('auth user created:', userId);

  const accept = await authService.acceptInvitation(userId, email, token);
  console.log('accept result:', accept);

  const me = await authService.me(userId);
  console.log('me.memberships:', JSON.stringify(me?.memberships), '| apps:', me?.apps);

  const m = me?.memberships[0];
  const pass =
    accept.role === 'member_pro' &&
    accept.tenantId === reg.tenantId &&
    m?.tenant_id === reg.tenantId &&
    m?.role === 'member_pro' &&
    (me?.apps.length ?? 0) === 3;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  // Cleanup: audit_log FKs are RESTRICT, so clear them before deleting the user/tenant.
  await pool.query(`delete from core.audit_log where actor_id=$1 or tenant_id=$2`, [userId, reg.tenantId]);
  await pool.query(`delete from core.outbox where aggregate_id=$1`, [reg.onboardingId]);
  await supabaseAdmin.auth.admin.deleteUser(userId);
  await pool.query(`delete from core.tenants where id=$1`, [reg.tenantId]);
  console.log('cleaned up');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
