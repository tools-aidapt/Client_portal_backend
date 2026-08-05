/* Live end-to-end test of self-hosted auth against the DB.
 * Run: npx tsx scripts/smoke-auth.ts
 */
import { authService } from '@modules/auth/services/auth.service.js';
import { verifyAccessToken } from '@modules/auth/utils/tokens.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();
const email = `user-${stamp}@auth.example`;
const password = 'CorrectHorse123';

async function main() {
  // 1. Register -> tokens.
  const reg = await authService.register({ email, password, fullName: 'Auth Tester' });
  const claims0 = verifyAccessToken(reg.accessToken);
  console.log('register:', `userId set=${!!reg.userId} typ/claims ok=${claims0.id === reg.userId}`,
    `tenant_roles empty=${Object.keys(claims0.app_metadata.tenant_roles).length === 0}`);

  // 2. Wrong password rejected.
  let badRejected = false;
  try { await authService.login({ email, password: 'wrong' }); } catch { badRejected = true; }

  // 3. Login -> tokens.
  const login = await authService.login({ email, password });

  // 4. Refresh rotates: old refresh token must stop working.
  const refreshed = await authService.refresh(login.refreshToken);
  let oldRefreshRejected = false;
  try { await authService.refresh(login.refreshToken); } catch { oldRefreshRejected = true; }

  // 5. Grant a membership, re-login -> claims now carry the tenant role.
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`Auth Co ${stamp}`, `auth-co-${stamp}`],
  );
  const tenantId = t[0]!.id;
  await pool.query(`insert into core.memberships (user_id, tenant_id, role, status) values ($1,$2,'member_pro','active')`, [reg.userId, tenantId]);
  const relogin = await authService.login({ email, password });
  const claims1 = verifyAccessToken(relogin.accessToken);
  console.log('claims after membership:', JSON.stringify(claims1.app_metadata.tenant_roles));

  // 6. me() reflects the membership.
  const me = await authService.me(reg.userId);
  const mem = me?.memberships[0];

  // 7. Logout revokes the (rotated) refresh token.
  await authService.logout(refreshed.refreshToken);
  let loggedOutRejected = false;
  try { await authService.refresh(refreshed.refreshToken); } catch { loggedOutRejected = true; }

  console.log('wrong-pw rejected:', badRejected, '| old-refresh rejected:', oldRefreshRejected,
    '| post-logout refresh rejected:', loggedOutRejected);

  const pass =
    claims0.id === reg.userId &&
    Object.keys(claims0.app_metadata.tenant_roles).length === 0 &&
    badRejected && oldRefreshRejected && loggedOutRejected &&
    claims1.app_metadata.tenant_roles[tenantId] === 'member_pro' &&
    mem?.role === 'member_pro' &&
    (me?.apps.length ?? 0) === 3;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.profiles where id = $1`, [reg.userId]);
  await pool.query(`delete from core.tenants where id = $1`, [tenantId]);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
