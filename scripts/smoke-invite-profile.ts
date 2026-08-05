/* Live test of role-at-invite + rich registration profile + profile update.
 * Does NOT hit n8n (no outbox drain). Run: npx tsx scripts/smoke-invite-profile.ts
 */
import { invitationsService } from '@modules/invitations/invitations.service.js';
import { authService } from '@modules/auth/services/auth.service.js';
import { verifyAccessToken } from '@modules/auth/utils/tokens.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();
const email = `admin-${stamp}@profile.example`;

async function main() {
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`Profile Co ${stamp}`, `profile-co-${stamp}`],
  );
  const tenantId = t[0]!.id;

  // Invite as super_admin (platform-admin grant).
  const { invitationId } = await invitationsService.invite({ tenantId, email, role: 'super_admin', invitedBy: null });
  const { rows: iv } = await pool.query<{ token: string }>(`select token from core.invitations where id=$1`, [invitationId]);
  const token = iv[0]!.token;

  // Register with rich profile.
  const reg = await authService.register({
    token,
    password: 'Password123',
    fullName: 'Ada Lovelace',
    jobTitle: 'Head of Ops',
    department: 'Operations',
    phone: '+254700000000',
    interests: ['automation', 'analytics'],
  });
  const claims = verifyAccessToken(reg.accessToken);
  const me = await authService.me(reg.userId);

  console.log('me:', JSON.stringify({
    dept: me?.department, title: me?.job_title, interests: me?.interests,
    platform_admin: me?.is_platform_admin, role: me?.memberships[0]?.role,
  }));
  console.log('claims:', `platform_admin=${claims.app_metadata.platform_admin}`,
    `role=${claims.app_metadata.tenant_roles[tenantId]}`);

  // Update profile.
  const updated = await authService.updateProfile(reg.userId, { department: 'Delivery', interests: ['ai', 'ops', 'data'] });

  const pass =
    me?.department === 'Operations' && me?.job_title === 'Head of Ops' &&
    Array.isArray(me?.interests) && me!.interests!.length === 2 &&
    me?.is_platform_admin === true &&
    me?.memberships[0]?.role === 'super_admin' &&
    claims.app_metadata.platform_admin === true &&
    claims.app_metadata.tenant_roles[tenantId] === 'super_admin' &&
    (updated as any)?.department === 'Delivery' &&
    (updated as any)?.interests?.length === 3;
  console.log('after update dept:', (updated as any)?.department, '| interests:', (updated as any)?.interests?.length);
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.outbox where aggregate='invitation' and aggregate_id=$1`, [invitationId]);
  await pool.query(`delete from core.profiles where id=$1`, [reg.userId]);
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
