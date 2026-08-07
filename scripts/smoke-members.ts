/* Throwaway: verify the admin member list + role/status write end-to-end over
 * HTTP against real Kenafric data. Reads the list, flips ONE deliberately-chosen
 * test account's role and status, runs the negative cases, then restores the
 * original values so live client data is left exactly as found.
 *
 * The target is pinned to a `*.test@kenafric.com` fixture, never whichever row
 * happens to sort first — a stray failure here must not leave a real person
 * suspended.
 *
 * Run: npx tsx scripts/smoke-members.ts   (needs `npm run dev` up)
 */
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const KEN = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const base = `http://localhost:${process.env.PORT ?? 4000}/api/v1`;

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

const { rows: admins } = await pool.query<{ id: string }>(
  `select id from core.profiles where is_platform_admin = true limit 1`,
);
// The one genuine non-platform-admin member of Kenafric: needed to prove the
// 403, because a platform admin's token passes `requirePlatformAdmin` via the
// `core.profiles` fallback even when the claim says otherwise.
const { rows: outsiders } = await pool.query<{ id: string }>(
  `select m.user_id as id
     from core.memberships m
     join core.profiles p on p.id = m.user_id
    where m.tenant_id = $1 and p.is_platform_admin = false
    order by m.joined_at asc
    limit 1`,
  [KEN],
);
const adminId = admins[0]?.id;
const outsiderId = outsiders[0]?.id;
if (!adminId) throw new Error('No platform admin profile found');
if (!outsiderId) throw new Error('No non-platform-admin Kenafric membership found');

const adminToken = signAccessToken(adminId, null, { platform_admin: true, tenant_roles: {} });
const outsiderToken = signAccessToken(outsiderId, null, {
  platform_admin: false,
  tenant_roles: { [KEN]: 'member_plus' },
});

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

const members = `/admin/clients/${KEN}/members`;

// --- 1. The list ------------------------------------------------------------
console.log('\nGET members');
const list = await call('GET', members, adminToken);
check('200', list.status === 200, `got ${list.status}`);
const rows: any[] = list.json?.data?.members ?? [];
check('returns real members', rows.length > 0, `${rows.length} rows`);
check(
  'every row carries the six documented fields',
  rows.every(
    (m) =>
      'user_id' in m && 'full_name' in m && 'email' in m && 'role' in m && 'status' in m && 'joined_at' in m,
  ),
);
check(
  'a member with no credentials row still appears (email null)',
  rows.some((m) => m.email === null),
  'no null-email member in this tenant — join coverage unproven',
);
console.log(`  (${rows.length} members: ${rows.map((m) => m.role).join(', ')})`);

// --- 2. Guards --------------------------------------------------------------
console.log('\nGuards');
check('403 for a real client member', (await call('GET', members, outsiderToken)).status === 403);
check('401 unauthenticated', (await call('GET', members, 'not-a-token')).status === 401);

// --- 3. The write -----------------------------------------------------------
const target = rows.find((m) => typeof m.email === 'string' && m.email.endsWith('.test@kenafric.com'));
if (!target) throw new Error('No *.test@kenafric.com fixture to write against — aborting, nothing changed');
const original = { role: target.role, status: target.status };
const one = `${members}/${target.user_id}`;
console.log(`\nPATCH ${target.email} (was ${original.role}/${original.status})`);

try {
  const promoted = await call('PATCH', one, adminToken, { role: 'member_pro' });
  check('200 on role change', promoted.status === 200, `got ${promoted.status}`);
  check('role applied', promoted.json?.data?.role === 'member_pro', JSON.stringify(promoted.json));
  check(
    'status untouched by a role-only patch',
    promoted.json?.data?.status === original.status,
    `status became ${promoted.json?.data?.status}`,
  );
  check('response carries the joined name/email', promoted.json?.data?.email === target.email);

  const suspended = await call('PATCH', one, adminToken, { status: 'suspended' });
  check('200 on status change', suspended.status === 200);
  check('status applied', suspended.json?.data?.status === 'suspended');
  check(
    'role untouched by a status-only patch',
    suspended.json?.data?.role === 'member_pro',
    `role became ${suspended.json?.data?.role}`,
  );

  const reread = await call('GET', members, adminToken);
  const fresh = (reread.json?.data?.members ?? []).find((m: any) => m.user_id === target.user_id);
  check('the list reflects the write', fresh?.role === 'member_pro' && fresh?.status === 'suspended');

  // --- 4. Rejections --------------------------------------------------------
  console.log('\nRejections');
  const superAdmin = await call('PATCH', one, adminToken, { role: 'super_admin' });
  check('super_admin rejected', superAdmin.status === 422, `got ${superAdmin.status}`);
  check(
    'and says why, by name',
    JSON.stringify(superAdmin.json).includes('platform-wide'),
    JSON.stringify(superAdmin.json).slice(0, 200),
  );

  check(
    'unknown role rejected',
    (await call('PATCH', one, adminToken, { role: 'wizard' })).status === 422,
  );
  check(
    'unknown status rejected',
    (await call('PATCH', one, adminToken, { status: 'deleted' })).status === 422,
  );
  check('empty body rejected', (await call('PATCH', one, adminToken, {})).status === 422);
  check(
    'a non-member 404s',
    (await call('PATCH', `${members}/00000000-0000-0000-0000-000000000000`, adminToken, {
      role: 'member',
    })).status === 404,
  );
  // The same person, addressed through a DIFFERENT client, must not be editable.
  const other = await call(
    'PATCH',
    `/admin/clients/98de6b10-7e63-4116-9d17-930906cbb4df/members/${target.user_id}`,
    adminToken,
    { role: 'member' },
  );
  check('cross-tenant edit 404s', other.status === 404, `got ${other.status}`);
} finally {
  // --- 5. Restore -----------------------------------------------------------
  const restored = await call('PATCH', one, adminToken, original);
  check(
    `restored to ${original.role}/${original.status}`,
    restored.json?.data?.role === original.role && restored.json?.data?.status === original.status,
    JSON.stringify(restored.json),
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
