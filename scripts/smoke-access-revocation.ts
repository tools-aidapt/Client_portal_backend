/* Live check of the two access controls added together: revoking one person's
 * Portal access, and switching a whole client off.
 *
 * Both existed as data and neither did anything. `core.app_access` was written
 * by invitations and by both admin screens but READ by nothing that decides
 * access — and the Portal row specifically could not even be written, since
 * `setAppAccess` force-added 'portal' on every call. `core.tenants.status` was
 * consulted by no code path at all. So this script's real job is to prove the
 * gates bite, not that the columns change:
 *
 *   - a revoked Portal grant refuses password login, OTP login and refresh
 *   - a suspended tenant refuses the same three, and every tenant-scoped route
 *   - a platform admin is exempt from both, or nobody could ever undo them
 *   - suspend kills live sessions; resume restores the PREVIOUS status
 *   - neither can be used to lock the actor out of the screen that undoes it
 *
 * Creates its own throwaway tenant and users so it never touches a real
 * client, and deletes everything at the end (including on failure). It calls
 * the service/repository layer directly rather than over HTTP, so nothing here
 * sends an email or reaches the LMS/Support Desk.
 *
 * Run: npx tsx scripts/smoke-access-revocation.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { pool } from '../src/infra/db/pool.js';
import { authService } from '../src/modules/auth/services/auth.service.js';
import { authRepo } from '../src/modules/auth/repositories/auth.repository.js';
import { adminTenantsRepo } from '../src/modules/admin/tenants/repositories/tenants.repository.js';
import { membersRepo } from '../src/modules/admin/clients/repositories/members.repository.js';
import { hashPassword } from '../src/modules/auth/utils/password.js';
import { hashOtpCode } from '../src/modules/auth/utils/otp.js';
import { requireTenantRole } from '../src/api/middlewares/tenant.js';
import type { NextFunction, Request, Response } from 'express';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs `fn` and reports the AppError code it threw, or null if it resolved. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
}

/**
 * Runs `requireTenantRole('member')` against a hand-built request and reports
 * the error code it refused with, or null if it let the request through.
 *
 * Exercised directly rather than over HTTP because this is the gate that has
 * to bite on a token that is still cryptographically valid — the one thing no
 * sign-in test can cover, since not signing in again is the whole point.
 */
async function tenantGate(userId: string, tenantId: string): Promise<string | null> {
  const req = {
    auth: { user: { id: userId } },
    query: {},
    header: (name: string) => (name === 'x-tenant-id' ? tenantId : undefined),
  } as unknown as Request;
  return new Promise((resolve) => {
    void requireTenantRole('member')(req, {} as Response, ((err?: unknown) => {
      resolve(err ? ((err as { code?: string }).code ?? (err as Error).message) : null);
    }) as NextFunction);
  });
}

const PASSWORD = 'Smoke-Access-1!';
const suffix = crypto.randomBytes(4).toString('hex');
/** Every profile this script creates, recorded as it is created. */
const userIds: string[] = [];

async function makeUser(
  tenantId: string,
  /** Unique per user — two accounts sharing a role must not share an email. */
  label: string,
  role: 'member' | 'admin',
  opts: { platformAdmin?: boolean; apps?: string[] } = {},
): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `smoke-access-${label}-${suffix}@aidapt.test`;
  await pool.query(
    `insert into core.profiles (id, full_name, is_platform_admin)
     values ($1, $2, $3)`,
    [id, `Smoke ${label} ${suffix}`, opts.platformAdmin === true],
  );
  await pool.query(
    `insert into core.user_credentials (user_id, email, password_hash) values ($1, $2, $3)`,
    [id, email, await hashPassword(PASSWORD)],
  );
  await pool.query(
    `insert into core.memberships (user_id, tenant_id, role, status)
     values ($1, $2, $3::core.user_role, 'active')`,
    [id, tenantId, role],
  );
  for (const app of opts.apps ?? ['portal']) {
    await pool.query(
      `insert into core.app_access (user_id, app, status) values ($1, $2::core.app_type, 'active')`,
      [id, app],
    );
  }
  userIds.push(id);
  return { id, email };
}

async function main() {
  const tenantId = crypto.randomUUID();

  try {
    // A throwaway client, created at 'onboarding' rather than 'active' on
    // purpose: resume has to put back what was there, and a tenant that starts
    // 'active' cannot tell a correct restore apart from a hardcoded 'active'.
    await pool.query(
      `insert into core.tenants (id, name, slug, status)
       values ($1, $2, $3, 'onboarding')`,
      [tenantId, `Smoke Access ${suffix}`, `smoke-access-${suffix}`],
    );

    // Ids are pushed by makeUser as each row lands, so a failure halfway
    // through still leaves the cleanup block something to delete.
    const member = await makeUser(tenantId, 'member', 'member', { apps: ['portal', 'lms'] });
    const owner = await makeUser(tenantId, 'owner', 'admin');
    const staff = await makeUser(tenantId, 'staff', 'admin', { platformAdmin: true });

    // ---------- 1. baseline ----------
    console.log('\n1. baseline — everyone can sign in before anything is revoked');
    check('member logs in', (await codeOf(() => authService.login({ email: member.email, password: PASSWORD }))) === null);
    check('org admin logs in', (await codeOf(() => authService.login({ email: owner.email, password: PASSWORD }))) === null);
    check('Aidapt staff log in', (await codeOf(() => authService.login({ email: staff.email, password: PASSWORD }))) === null);

    // ---------- 2. Portal access is now actually revocable ----------
    console.log('\n2. revoking Portal access');
    const before = await membersRepo.byId(tenantId, member.id);
    check('member starts with portal + lms', before?.apps.includes('portal') === true && before?.apps.includes('lms') === true, String(before?.apps));

    // The whole point: this call used to silently re-add 'portal'.
    const after = await membersRepo.setAppAccess(tenantId, member.id, ['lms'], staff.id);
    check('portal is gone from the row', after?.apps.includes('portal') === false, String(after?.apps));
    check('lms survived the exact-set write', after?.apps.includes('lms') === true);
    const { rows: revoked } = await pool.query<{ status: string; revoked_at: string | null }>(
      `select status, revoked_at from core.app_access where user_id = $1 and app = 'portal'`,
      [member.id],
    );
    check('the row is revoked, not deleted', revoked[0]?.status === 'revoked' && revoked[0]?.revoked_at !== null);

    // ---------- 3. the revoke bites on every sign-in path ----------
    console.log('\n3. a revoked Portal grant refuses every way in');
    check(
      'password login → PORTAL_ACCESS_REVOKED',
      (await codeOf(() => authService.login({ email: member.email, password: PASSWORD }))) === 'PORTAL_ACCESS_REVOKED',
    );
    // A REAL, valid OTP, not a made-up one: a wrong code fails at the code
    // check and would pass this test without the gate ever running.
    const otp = '424242';
    await authRepo.createOtpCode(member.id, hashOtpCode(otp), new Date(Date.now() + 600_000));
    check(
      'a VALID OTP is refused too → PORTAL_ACCESS_REVOKED',
      (await codeOf(() => authService.verifyOtp({ email: member.email, code: otp }))) === 'PORTAL_ACCESS_REVOKED',
    );

    // A session that was live BEFORE the revoke must not renew itself.
    const live = await authService.login({ email: owner.email, password: PASSWORD });
    await membersRepo.setAppAccess(tenantId, owner.id, [], staff.id);
    check(
      'a refresh token issued before the revoke stops working',
      (await codeOf(() => authService.refresh(live.refreshToken))) === 'PORTAL_ACCESS_REVOKED',
    );
    // Put it back — later steps need this account able to sign in.
    await membersRepo.setAppAccess(tenantId, owner.id, ['portal'], staff.id);
    check('re-granting restores sign-in', (await codeOf(() => authService.login({ email: owner.email, password: PASSWORD }))) === null);

    // ---------- 4. suspending the client ----------
    console.log('\n4. suspending the whole client');
    const stillLive = await authService.login({ email: owner.email, password: PASSWORD });
    const { tenant: suspended, sessionsRevoked } = await adminTenantsRepo.suspend(
      tenantId,
      staff.id,
      'smoke test',
    );
    check('status is suspended', suspended?.status === 'suspended');
    check('the previous status was remembered', await previousStatusIs(tenantId, 'onboarding'));
    check('live sessions were killed', sessionsRevoked >= 1, `${sessionsRevoked} revoked`);
    check(
      'that refresh token is dead',
      (await codeOf(() => authService.refresh(stillLive.refreshToken))) !== null,
    );
    check(
      'sign-in is refused with TENANT_SUSPENDED',
      (await codeOf(() => authService.login({ email: owner.email, password: PASSWORD }))) === 'TENANT_SUSPENDED',
    );
    check(
      'Aidapt staff are exempt — they are who lifts it',
      (await codeOf(() => authService.login({ email: staff.email, password: PASSWORD }))) === null,
    );

    // ---------- 5. resume restores the status it replaced ----------
    console.log('\n5. resuming');
    const resumed = await adminTenantsRepo.resume(tenantId, staff.id);
    check(
      'restored to onboarding, NOT a hardcoded active',
      resumed?.status === 'onboarding',
      String(resumed?.status),
    );
    check('suspension fields are cleared', resumed?.suspended_at === null && resumed?.suspension_reason === null);
    check('sign-in works again', (await codeOf(() => authService.login({ email: owner.email, password: PASSWORD }))) === null);
    check('a second resume is refused, not a silent status rewrite', (await adminTenantsRepo.resume(tenantId, staff.id)) === null);

    // ---------- 6. the guards that stop a lockout ----------
    console.log('\n6. guards');
    const { tenant: protectedTenant } = await adminTenantsRepo.suspend(
      (await pool.query<{ id: string }>(`select id from core.tenants where is_protected limit 1`)).rows[0]!.id,
      staff.id,
      'should never apply',
    );
    check('the Aidapt client group cannot be suspended', protectedTenant === null);

    check(
      'last-admin check sees the remaining admin',
      (await membersRepo.otherActivePortalAdmins(tenantId, owner.id)) >= 1,
    );
    // Strip the other admin's Portal access and the count must fall to zero,
    // which is what the client-side guard refuses on.
    await membersRepo.setAppAccess(tenantId, staff.id, [], owner.id);
    check(
      'and falls to zero once nobody else can open the Portal',
      (await membersRepo.otherActivePortalAdmins(tenantId, owner.id)) === 0,
    );

    // ---------- 7. the per-request gate ----------
    // Everything above proves a revoke blocks a NEW session. This proves it
    // also stops an access token that was minted before the revoke and is
    // still inside its ~15-minute life — without this, "revoke" would have
    // meant "in a quarter of an hour".
    console.log('\n7. requireTenantRole, on a token that is still valid');
    // Set the starting state explicitly rather than inheriting whatever the
    // earlier sections left — the member's Portal access was revoked back in
    // section 3 and never restored, so the baseline below would otherwise be
    // asserting the opposite of what it says.
    await membersRepo.setAppAccess(tenantId, member.id, ['portal', 'lms'], staff.id);
    check('a normal member passes the gate', (await tenantGate(member.id, tenantId)) === null);

    await membersRepo.setAppAccess(tenantId, member.id, ['lms'], staff.id);
    check(
      'revoked Portal access is refused mid-session',
      (await tenantGate(member.id, tenantId)) === 'PORTAL_ACCESS_REVOKED',
    );
    await membersRepo.setAppAccess(tenantId, member.id, ['portal', 'lms'], staff.id);

    await adminTenantsRepo.suspend(tenantId, staff.id, 'smoke test — mid-session');
    check(
      'a suspended tenant is refused mid-session',
      (await tenantGate(member.id, tenantId)) === 'TENANT_SUSPENDED',
    );
    check(
      'Aidapt staff still get through, so the suspension stays liftable',
      (await tenantGate(staff.id, tenantId)) === null,
    );
    await adminTenantsRepo.resume(tenantId, staff.id);
    check('and the gate reopens once resumed', (await tenantGate(member.id, tenantId)) === null);

    // ---------- 8. audit trail ----------
    console.log('\n8. audit');
    const { rows: audit } = await pool.query<{ action: string }>(
      `select action from core.audit_log where tenant_id = $1 order by created_at`,
      [tenantId],
    );
    check('suspend and resume are both recorded', audit.some((r) => r.action === 'tenant.suspended') && audit.some((r) => r.action === 'tenant.resumed'), audit.map((r) => r.action).join(', '));
  } catch (e) {
    // Without this, the `finally` below exits(0) on a thrown error and reports
    // a clean run that never executed a single check.
    failed++;
    console.error('\n  FAIL the run threw before finishing:\n', e);
  } finally {
    // ---------- cleanup ----------
    console.log('\ncleanup');
    for (const id of userIds) {
      await pool.query(`delete from core.refresh_tokens where user_id = $1`, [id]);
      await pool.query(`delete from core.otp_codes where user_id = $1`, [id]);
      await pool.query(`delete from core.app_access where user_id = $1`, [id]);
      await pool.query(`delete from core.memberships where user_id = $1`, [id]);
      await pool.query(`delete from core.user_credentials where user_id = $1`, [id]);
      await pool.query(`update core.audit_log set actor_id = null where actor_id = $1`, [id]);
      await pool.query(`delete from core.profiles where id = $1`, [id]);
    }
    await pool.query(`delete from core.audit_log where tenant_id = $1`, [tenantId]);
    await pool.query(`delete from core.tenants where id = $1`, [tenantId]);
    console.log('  removed the throwaway tenant and its users');

    console.log(`\n${passed}/${passed + failed} checks passed`);
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  }
}

async function previousStatusIs(tenantId: string, expected: string): Promise<boolean> {
  const { rows } = await pool.query<{ s: string | null }>(
    `select status_before_suspension::text as s from core.tenants where id = $1`,
    [tenantId],
  );
  return rows[0]?.s === expected;
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
