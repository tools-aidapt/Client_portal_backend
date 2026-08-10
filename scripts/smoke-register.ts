/* Throwaway: verify the invitation → /register → live session chain end to end
 * over HTTP, the flow that was dead because the frontend had no /register page.
 *
 * Creates a real invitation on Kenafric for a throwaway address, registers
 * against it exactly as the new Register.tsx does, proves the returned session
 * actually works, then DELETES the created account and invitation so live data
 * is left as found.
 *
 * Run against an isolated backend that has LMS/Support Desk sync pointed
 * somewhere dead, or registering here creates accounts in those apps too that
 * this script cannot clean up:
 *   PORT=4100 LMS_URL=http://127.0.0.1:9 SUPPORT_DESK_BACKEND_URL=http://127.0.0.1:9 npx tsx src/server.ts
 *   PORT=4100 npx tsx scripts/smoke-register.ts
 */
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const KEN = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const base = `http://localhost:${process.env.PORT ?? 4000}/api/v1`;
const EMAIL = `register.smoke.${Date.now()}@aidapt.co`;
const PASSWORD = 'SmokeTest!2026';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: text };
  }
}

const { rows: admins } = await pool.query<{ id: string }>(
  `select id from core.profiles where is_platform_admin = true limit 1`,
);
const adminToken = signAccessToken(admins[0]!.id, null, { platform_admin: true, tenant_roles: {} });

let userId: string | null = null;
let invitationId: string | null = null;

try {
  // --- 1. Invite, exactly as the admin Users page does ----------------------
  console.log('\nInvitation');
  const invited = await call(
    'POST',
    `/admin/clients/${KEN}/invitations`,
    { email: EMAIL, role: 'member_plus' },
    adminToken,
  );
  check('201 from the admin invite endpoint', invited.status === 201, `got ${invited.status}`);
  invitationId = invited.json?.data?.invitationId ?? null;
  check('an invitation id came back', !!invitationId);

  const { rows: invRows } = await pool.query<{ token: string; role: string }>(
    `select token, role from core.invitations where id = $1`,
    [invitationId],
  );
  const token = invRows[0]?.token;
  check('the invitation row carries a token', !!token);
  console.log(`  (token ${token?.slice(0, 12)}… → /register?token=${token?.slice(0, 12)}…)`);

  // --- 2. The negative cases the page must show, not swallow ----------------
  console.log('\nRejections the page surfaces');
  const unknown = await call('POST', '/auth/register', {
    token: 'not-a-real-token',
    password: PASSWORD,
    fullName: 'Nobody',
  });
  check('unknown token 404s', unknown.status === 404, `got ${unknown.status}`);
  check(
    'and says the invitation was not found',
    /not found/i.test(JSON.stringify(unknown.json)),
    JSON.stringify(unknown.json).slice(0, 160),
  );

  const short = await call('POST', '/auth/register', {
    token,
    password: 'short',
    fullName: 'Too Short',
  });
  check('a <8 char password 422s', short.status === 422, `got ${short.status}`);

  const noName = await call('POST', '/auth/register', { token, password: PASSWORD });
  check('a missing full name 422s', noName.status === 422, `got ${noName.status}`);

  // --- 3. The real thing ----------------------------------------------------
  console.log('\nRegistration');
  const reg = await call('POST', '/auth/register', {
    token,
    password: PASSWORD,
    fullName: 'Register Smoke',
  });
  check('201 created', reg.status === 201, `got ${reg.status}`);
  const data = reg.json?.data ?? {};
  userId = data.userId ?? null;
  check('returns userId', !!data.userId);
  check('returns email (the field added for this)', data.email === EMAIL, `got ${data.email}`);
  check('returns an access token', typeof data.accessToken === 'string' && data.accessToken.length > 20);
  check('returns a refresh token', typeof data.refreshToken === 'string');

  // --- 4. The session is real, not just well-shaped -------------------------
  console.log('\nThe returned session actually works');
  const me = await call('GET', '/auth/me', undefined, data.accessToken);
  check('GET /auth/me accepts the new access token', me.status === 200, `got ${me.status}`);
  check('and reports the chosen name', me.json?.data?.full_name === 'Register Smoke');
  const memberships = me.json?.data?.memberships ?? [];
  check('the person is a member of Kenafric', memberships.some((m: any) => m.tenant_id === KEN));
  check(
    'with the role from the invitation, not a default',
    memberships.find((m: any) => m.tenant_id === KEN)?.role === 'member_plus',
    JSON.stringify(memberships),
  );

  // The whole point: they can now sign in normally with the password they set.
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  check('the new password works on /auth/login', login.status === 200, `got ${login.status}`);

  // A member_plus read, to prove the session is usable and not just issued.
  const dash = await call('GET', '/dashboard', undefined, data.accessToken);
  check('a real tenant-scoped read succeeds', dash.status === 200, `got ${dash.status}`);

  // --- 5. The token is single-use -------------------------------------------
  console.log('\nReuse');
  const reused = await call('POST', '/auth/register', {
    token,
    password: PASSWORD,
    fullName: 'Second Attempt',
  });
  check('re-registering the same token is rejected', reused.status >= 400, `got ${reused.status}`);
  check(
    'with a distinct, surfaceable reason',
    /already/i.test(JSON.stringify(reused.json)),
    JSON.stringify(reused.json).slice(0, 200),
  );

  const { rows: after } = await pool.query<{ status: string }>(
    `select status from core.invitations where id = $1`,
    [invitationId],
  );
  check('the invitation is marked accepted', after[0]?.status === 'accepted', after[0]?.status);
} finally {
  // --- 6. Leave nothing behind ---------------------------------------------
  console.log('\nCleanup');
  if (userId) {
    await pool.query(`delete from core.memberships where user_id = $1`, [userId]);
    await pool.query(`delete from core.refresh_tokens where user_id = $1`, [userId]);
    await pool.query(`delete from core.user_credentials where user_id = $1`, [userId]);
    await pool.query(`delete from core.profiles where id = $1`, [userId]);
  }
  if (invitationId) {
    await pool.query(`delete from core.outbox where aggregate_id = $1`, [invitationId]);
    await pool.query(`delete from core.invitations where id = $1`, [invitationId]);
  }
  const { rows: left } = await pool.query(
    `select 1 from core.user_credentials where lower(email) = lower($1)`,
    [EMAIL],
  );
  check('test account removed', left.length === 0);
  const { rows: invLeft } = await pool.query(`select 1 from core.invitations where id = $1`, [
    invitationId,
  ]);
  check('test invitation removed', invLeft.length === 0);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
