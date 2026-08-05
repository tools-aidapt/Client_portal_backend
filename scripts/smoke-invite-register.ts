/* Live end-to-end test of invitation-gated registration + n8n invite email.
 * NOTE: this actually POSTs to the real N8N_INVITE_WEBHOOK_URL, so a test
 * invitation email will be dispatched to the address below.
 *
 * Run: npx tsx scripts/smoke-invite-register.ts
 */
import { withTransaction, pool } from '@infra/db/pool.js';
import { onboardingRepo } from '@modules/admin/clients/repositories/onboarding.repository.js';
import { drainOnce } from '@modules/outbox/worker.js';
import { authService } from '@modules/auth/services/auth.service.js';
import { verifyAccessToken } from '@modules/auth/utils/tokens.js';

const stamp = Date.now();
const inviteEmail = `qa+invite-${stamp}@aidapt.co`; // your domain, so you can verify delivery

async function main() {
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`Invite Co ${stamp}`, `invite-co-${stamp}`],
  );
  const tenantId = t[0]!.id;

  // Admin invites a user (creates invitation + queues email).
  const invite = await withTransaction(async (client) => {
    const inv = await onboardingRepo.createInvitation(client, tenantId, inviteEmail, 'member_pro', null);
    await onboardingRepo.enqueueOutbox(client, {
      aggregate: 'invitation',
      aggregateId: inv.id,
      eventType: 'email.invite',
      payload: { tenantId, email: inviteEmail, token: inv.token },
      idempotencyKey: `email.invite:${inv.id}`,
    });
    return inv;
  });

  // Drain the outbox -> dispatches the invite email via n8n (invite still pending).
  const drain = await drainOnce();
  console.log('email dispatch drain:', JSON.stringify(drain), `-> sent to ${inviteEmail}`);

  // Registering without a valid token must fail.
  let badTokenRejected = false;
  try { await authService.register({ token: 'not-a-real-token', password: 'Password123' }); }
  catch { badTokenRejected = true; }

  // Register WITH the invite token -> account + membership in the invited org.
  const reg = await authService.register({ token: invite.token, password: 'Password123', fullName: 'Invited User' });
  const claims = verifyAccessToken(reg.accessToken);

  const { rows: cred } = await pool.query(`select email from core.user_credentials where user_id=$1`, [reg.userId]);
  const { rows: mem } = await pool.query(`select role from core.memberships where user_id=$1 and tenant_id=$2`, [reg.userId, tenantId]);
  const { rows: inv2 } = await pool.query(`select status from core.invitations where id=$1`, [invite.id]);

  // Reusing the (now accepted) token must fail.
  let reuseRejected = false;
  try { await authService.register({ token: invite.token, password: 'Password123' }); }
  catch { reuseRejected = true; }

  console.log('registered email:', cred[0]?.email, '| membership role:', mem[0]?.role,
    '| invite status:', inv2[0]?.status, '| claim role:', claims.app_metadata.tenant_roles[tenantId]);
  console.log('bad-token rejected:', badTokenRejected, '| token reuse rejected:', reuseRejected);

  const pass =
    badTokenRejected &&
    cred[0]?.email === inviteEmail &&
    mem[0]?.role === 'member_pro' &&
    inv2[0]?.status === 'accepted' &&
    claims.app_metadata.tenant_roles[tenantId] === 'member_pro' &&
    reuseRejected;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  // Cleanup.
  await pool.query(`delete from core.outbox where aggregate='invitation' and aggregate_id=$1`, [invite.id]);
  await pool.query(`delete from core.profiles where id=$1`, [reg.userId]);
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
