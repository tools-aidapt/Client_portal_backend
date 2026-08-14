/* Live check of listing and revoking invitations.
 *
 * core.invitations has always modelled `revoked`, and registerViaInvitation
 * has always refused a revoked token — but nothing could SET that status and
 * nothing could list invitations, so 22 rows existed that nobody could see or
 * withdraw. This proves the loop now closes: send -> list -> revoke -> the
 * token is genuinely dead.
 *
 * Writes rows directly rather than calling POST /admin/clients/:id/invitations,
 * which posts to the LIVE n8n invite webhook and would email a real person.
 * Everything it creates is deleted.
 *
 * Run: npx tsx scripts/smoke-invitations.ts
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { invitationsRepo } from '../src/modules/admin/clients/repositories/invitations.repository.js';
import { authRepo } from '../src/modules/auth/repositories/auth.repository.js';
import { pool } from '../src/infra/db/pool.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function seed(tenantId: string, opts: { status?: string; expiresDays?: number } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.invitations (tenant_id, email, role, token, status, expires_at)
     values ($1, $2, 'member', $3, $4::core.invitation_status,
             now() + ($5 || ' days')::interval)
     returning id`,
    [
      tenantId,
      `inv-smoke-${crypto.randomBytes(4).toString('hex')}@aidapt.test`,
      token,
      opts.status ?? 'pending',
      String(opts.expiresDays ?? 14),
    ],
  );
  return { id: rows[0]!.id, token };
}

async function main() {
  const { rows: t } = await pool.query<{ id: string; name: string }>(
    `select id, name from core.tenants where slug = 'kenafric'`,
  );
  const tenantId = t[0]!.id;
  const { rows: other } = await pool.query<{ id: string }>(
    `select id from core.tenants where slug <> 'kenafric' limit 1`,
  );
  const otherTenantId = other[0]!.id;

  const created: string[] = [];
  try {
    // ---------- 1. list ----------
    console.log('\n1. list');
    const before = await invitationsRepo.list(tenantId);
    const pending = await seed(tenantId);
    created.push(pending.id);
    const after = await invitationsRepo.list(tenantId);
    check('list returns the new invitation', after.length === before.length + 1);
    const row = after.find((r) => r.id === pending.id)!;
    check('carries email/role/apps/expiry', !!row.email && !!row.role && Array.isArray(row.apps), JSON.stringify(row.apps));
    check('effective_status is pending', row.effective_status === 'pending');

    // ---------- 2. expired shows as expired, not pending ----------
    console.log('\n2. an expired-but-still-pending row reads as expired');
    const stale = await seed(tenantId, { expiresDays: -1 });
    created.push(stale.id);
    const staleRow = (await invitationsRepo.list(tenantId)).find((r) => r.id === stale.id)!;
    check('raw status is still pending', staleRow.status === 'pending');
    check('effective_status is expired', staleRow.effective_status === 'expired', staleRow.effective_status);

    // ---------- 3. revoke ----------
    console.log('\n3. revoke');
    const revoked = await invitationsRepo.revoke(tenantId, pending.id);
    check('revoke returns the row', revoked !== null);
    check('status is now revoked', revoked?.effective_status === 'revoked', revoked?.effective_status);
    const second = await invitationsRepo.revoke(tenantId, pending.id);
    check('revoking twice is a no-op (null, not an error)', second === null);

    // ---------- 4. the revoked token is genuinely dead ----------
    console.log('\n4. a revoked token can no longer register');
    let message = '';
    try {
      await authRepo.registerViaInvitation({
        token: pending.token,
        passwordHash: 'x'.repeat(60),
        profile: { fullName: 'Should Not Exist' },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    check('registration refused', /revoked/i.test(message), message || '(no error thrown!)');
    const { rows: leaked } = await pool.query<{ n: string }>(
      `select count(*) n from core.profiles p
         join core.user_credentials u on u.user_id = p.id
        where u.email like 'inv-smoke-%'`,
    );
    check('no account was created', leaked[0]!.n === '0');

    // ---------- 5. tenant scoping ----------
    console.log('\n5. one client cannot revoke another client’s invitation');
    const foreign = await seed(tenantId);
    created.push(foreign.id);
    const cross = await invitationsRepo.revoke(otherTenantId, foreign.id);
    check('revoke via the wrong tenant returns null', cross === null);
    const stillPending = (await invitationsRepo.list(tenantId)).find((r) => r.id === foreign.id)!;
    check('the invitation is untouched', stillPending.effective_status === 'pending');
    check('statusOf via the wrong tenant is null (404, not 409)', (await invitationsRepo.statusOf(otherTenantId, foreign.id)) === null);

    // ---------- 6. accepted invitations are not rewritten ----------
    console.log('\n6. an accepted invitation cannot be revoked');
    const accepted = await seed(tenantId, { status: 'accepted' });
    created.push(accepted.id);
    check('revoke returns null', (await invitationsRepo.revoke(tenantId, accepted.id)) === null);
    check('status stays accepted', (await invitationsRepo.statusOf(tenantId, accepted.id)) === 'accepted');
  } finally {
    if (created.length) {
      await pool.query(`delete from core.invitations where id = any($1::uuid[])`, [created]);
    }
    const { rows: left } = await pool.query<{ n: string }>(
      `select count(*) n from core.invitations where email like 'inv-smoke-%'`,
    );
    console.log('\ncleanup');
    check('all test invitations removed', left[0]!.n === '0');

    console.log(`\n${passed}/${passed + failed} checks passed`);
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
