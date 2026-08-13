/* Live check that Portal stamps and filters `core.refresh_tokens.app`.
 *
 * Migrations 0036/0037 added `app` to a table LMS and Support Desk are about
 * to share. This proves the four touched repository functions behave against
 * the real database: the insert stamps 'portal', and find/revoke/revoke-all
 * are scoped to Portal's own rows and cannot touch another app's session.
 *
 * Uses an existing seeded account and NEVER calls `authService.register` —
 * registration fires syncUserToLms/syncUserToSupportDesk and would create
 * accounts in two other teams' live systems.
 *
 * Creates only refresh-token rows, and deletes every one it created.
 *
 * Run: npx tsx scripts/smoke-refresh-token-app.ts
 */
import 'dotenv/config';
import { authService } from '../src/modules/auth/services/auth.service.js';
import { authRepo } from '../src/modules/auth/repositories/auth.repository.js';
import { hashPassword } from '../src/modules/auth/utils/password.js';
import { pool } from '../src/infra/db/pool.js';

/**
 * A throwaway account created and deleted by this script — writing
 * core.profiles + core.user_credentials directly, exactly as
 * seed-test-users.ts does, so no existing account's password is needed and
 * nothing goes near the invitation/registration path.
 */
const EMAIL = `refresh-app-smoke-${Date.now()}@aidapt.test`;
const PASSWORD = 'SmokeTest!RefreshApp2026';

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

type TokenRow = { id: string; app: string | null; revoked_at: Date | null };

async function newestRow(userId: string): Promise<TokenRow | undefined> {
  const { rows } = await pool.query<TokenRow>(
    `select id, app::text as app, revoked_at from core.refresh_tokens
      where user_id = $1 order by created_at desc limit 1`,
    [userId],
  );
  return rows[0];
}

async function rowById(id: string): Promise<TokenRow | undefined> {
  const { rows } = await pool.query<TokenRow>(
    `select id, app::text as app, revoked_at from core.refresh_tokens where id = $1`,
    [id],
  );
  return rows[0];
}

async function main() {
  const created: string[] = [];
  let foreignRowId: string | null = null;

  const { rows: profileRows } = await pool.query<{ id: string }>(
    `insert into core.profiles (full_name) values ('Refresh App Smoke') returning id`,
  );
  const userId = profileRows[0]!.id;
  await pool.query(
    `insert into core.user_credentials (user_id, email, password_hash) values ($1, $2, $3)`,
    [userId, EMAIL, await hashPassword(PASSWORD)],
  );
  console.log(`throwaway user ${userId} (${EMAIL})`);

  const before = await pool.query<{ n: string }>(
    `select count(*) n from core.refresh_tokens where user_id = $1`,
    [userId],
  );

  try {
    // 1. A fresh login writes a live row stamped 'portal'.
    console.log('\n1. login stamps app');
    const login = await authService.login({ email: EMAIL, password: PASSWORD }, 'smoke-app-col');
    const loginRow = await newestRow(userId);
    if (loginRow) created.push(loginRow.id);
    check('login wrote a row', !!loginRow);
    check("app = 'portal'", loginRow?.app === 'portal', `got ${loginRow?.app}`);
    check('row is live', loginRow?.revoked_at === null);

    // 2. Refresh still rotates — findActiveRefreshToken's new `app` filter
    //    must not stop a legitimate Portal token from being found.
    console.log('\n2. refresh rotation still works');
    const rotated = await authService.refresh(login.refreshToken, 'smoke-app-col');
    const rotatedRow = await newestRow(userId);
    if (rotatedRow) created.push(rotatedRow.id);
    check('rotation issued a new token', !!rotated.refreshToken && rotated.refreshToken !== login.refreshToken);
    check("rotated row app = 'portal'", rotatedRow?.app === 'portal', `got ${rotatedRow?.app}`);
    check('old row revoked by rotation', (await rowById(loginRow!.id))?.revoked_at !== null);

    // 3. Logout revokes that row (revokeRefreshToken).
    console.log('\n3. logout revokes');
    const out = await authService.logout(rotated.refreshToken);
    check('logout reported a revoke', out.revoked === true);
    check('revoked_at now set', (await rowById(rotatedRow!.id))?.revoked_at !== null);

    // 4. revokeAllRefreshTokens clears every live PORTAL session...
    console.log('\n4. logout-all revokes Portal sessions');
    const a = await authService.login({ email: EMAIL, password: PASSWORD }, 'smoke-app-col');
    const b = await authService.login({ email: EMAIL, password: PASSWORD }, 'smoke-app-col');
    const { rows: liveBefore } = await pool.query<{ id: string }>(
      `select id from core.refresh_tokens where user_id = $1 and revoked_at is null`,
      [userId],
    );
    liveBefore.forEach((r) => created.push(r.id));
    check('two live Portal sessions', liveBefore.length === 2, `got ${liveBefore.length}`);

    // ...and must NOT touch another app's row in the same shared table.
    const { rows: foreign } = await pool.query<{ id: string }>(
      `insert into core.refresh_tokens (user_id, token_hash, expires_at, user_agent, app)
       values ($1, $2, now() + interval '30 days', 'smoke-app-col', 'lms') returning id`,
      [userId, `smoke-foreign-${Date.now()}`],
    );
    foreignRowId = foreign[0]!.id;

    await authService.logoutAll(userId);

    const { rows: liveAfter } = await pool.query<{ n: string }>(
      `select count(*) n from core.refresh_tokens
        where user_id = $1 and revoked_at is null and app = 'portal'`,
      [userId],
    );
    check('no live Portal sessions left', liveAfter[0]?.n === '0', `got ${liveAfter[0]?.n}`);
    check(
      "LMS row untouched by Portal's logout-all",
      (await rowById(foreignRowId))?.revoked_at === null,
    );

    // 5. Portal's finder must never resolve another app's token.
    console.log("\n5. findActiveRefreshToken is scoped to Portal");
    const { rows: h } = await pool.query<{ token_hash: string }>(
      `select token_hash from core.refresh_tokens where id = $1`,
      [foreignRowId],
    );
    const found = await authRepo.findActiveRefreshToken(h[0]!.token_hash);
    check('LMS token not found by Portal', found === null);
    check('revokeRefreshToken ignores LMS token', (await authRepo.revokeRefreshToken(h[0]!.token_hash)) === false);
    check('LMS row still live', (await rowById(foreignRowId))?.revoked_at === null);
  } catch (err) {
    failed++;
    console.log(`\n  FAIL threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Clean up: drop every row this run created, restore the prior count.
    const ids = [...new Set(created)];
    if (ids.length) {
      await pool.query(`delete from core.refresh_tokens where id = any($1::uuid[])`, [ids]);
    }
    if (foreignRowId) {
      await pool.query(`delete from core.refresh_tokens where id = $1`, [foreignRowId]);
    }
    const after = await pool.query<{ n: string }>(
      `select count(*) n from core.refresh_tokens where user_id = $1`,
      [userId],
    );
    console.log('\ncleanup');
    check(
      'row count restored',
      after.rows[0]!.n === before.rows[0]!.n,
      `${before.rows[0]!.n} → ${after.rows[0]!.n}`,
    );
    const { rows: nulls } = await pool.query<{ n: string }>(
      `select count(*) n from core.refresh_tokens where app is null`,
    );
    check('no untagged rows anywhere', nulls[0]!.n === '0', `${nulls[0]!.n} null`);

    // Drop the throwaway account itself.
    await pool.query(`delete from core.refresh_tokens where user_id = $1`, [userId]);
    await pool.query(`delete from core.user_credentials where user_id = $1`, [userId]);
    await pool.query(`delete from core.profiles where id = $1`, [userId]);
    const { rows: gone } = await pool.query<{ n: string }>(
      `select count(*) n from core.profiles where id = $1`,
      [userId],
    );
    check('throwaway user deleted', gone[0]!.n === '0');

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
