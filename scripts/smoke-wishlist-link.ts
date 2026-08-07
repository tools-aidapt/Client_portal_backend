/* Throwaway: verify the wishlist → onboarding link end-to-end over HTTP against
 * real Kenafric data. Links a task, reads it back through GET /onboarding, runs
 * the negative cases, then UNLINKS so live client data is left exactly as found.
 *
 * Run: npx tsx scripts/smoke-wishlist-link.ts   (needs `npm run dev` up)
 */
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const KEN = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const base = `http://localhost:${process.env.PORT ?? 4000}/api/v1`;

const { rows: admins } = await pool.query<{ id: string }>(
  `select id from core.profiles where is_platform_admin = true limit 1`,
);
const { rows: members } = await pool.query<{ id: string }>(
  `select user_id as id from core.memberships where tenant_id = $1 and status = 'active' limit 1`,
  [KEN],
);
const adminId = admins[0]?.id;
const memberId = members[0]?.id;
if (!adminId) throw new Error('No platform admin profile found');
if (!memberId) throw new Error('No active Kenafric membership found');

const adminToken = signAccessToken(adminId, null, { platform_admin: true, tenant_roles: {} });
const memberToken = signAccessToken(memberId, null, {
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
      'x-tenant-id': KEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

function show(label: string, r: { status: number; json: any }): void {
  const s = JSON.stringify(r.json);
  console.log(`${label} -> HTTP ${r.status}: ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
}

// 1. GET /onboarding must be a 200 at all (it was a 500 — ambiguous column).
const before = await call('GET', '/onboarding', memberToken);
console.log(`1. GET /onboarding -> HTTP ${before.status}, ${before.json?.data?.tasks?.length} tasks`);
console.log('   first task:', JSON.stringify(before.json?.data?.tasks?.[0]));

// 2. The admin's pick-list of wishlist items.
const items = await call('GET', `/admin/clients/${KEN}/wishlist-items`, adminToken);
show('2. GET /admin/clients/:id/wishlist-items', items);

const item = items.json?.data?.items?.[0];
const task = before.json?.data?.tasks?.[0];
if (!item || !task) throw new Error('Need at least one wishlist item and one onboarding task');

// 3. Link it.
const linked = await call(
  'PATCH',
  `/admin/clients/${KEN}/tasks/${task.clickup_task_id}/wishlist-source`,
  adminToken,
  { wishlist_item_id: item.id },
);
show('3. PATCH …/wishlist-source (link)', linked);

// 4. The client read now carries the item's TITLE, not just the id.
const after = await call('GET', '/onboarding', memberToken);
const linkedRow = after.json?.data?.tasks?.find((t: any) => t.clickup_task_id === task.clickup_task_id);
console.log('4. GET /onboarding linked row:', JSON.stringify({
  name: linkedRow?.name,
  source_wishlist_item_id: linkedRow?.source_wishlist_item_id,
  source_wishlist_title: linkedRow?.source_wishlist_title,
}));

// 5. Negative cases.
show('5a. unknown task id', await call('PATCH', `/admin/clients/${KEN}/tasks/nope-not-a-task/wishlist-source`, adminToken, { wishlist_item_id: item.id }));
show('5b. wishlist item from another tenant', await call('PATCH', `/admin/clients/${KEN}/tasks/${task.clickup_task_id}/wishlist-source`, adminToken, { wishlist_item_id: '11111111-1111-1111-1111-111111111111' }));
// NB: a synthetic subject, NOT memberToken — every profile in this database is
// a platform admin today, so the real Kenafric member passes the gate correctly
// (requirePlatformAdmin's DB fallback finds is_platform_admin = true) and would
// make this case look like a bypass.
const outsiderToken = signAccessToken('44444444-4444-4444-4444-444444444444', null, {
  platform_admin: false,
  tenant_roles: { [KEN]: 'member_plus' },
});
show('5c. non-admin caller', await call('PATCH', `/admin/clients/${KEN}/tasks/${task.clickup_task_id}/wishlist-source`, outsiderToken, { wishlist_item_id: item.id }));
show('5d. bad body', await call('PATCH', `/admin/clients/${KEN}/tasks/${task.clickup_task_id}/wishlist-source`, adminToken, { wishlist_item_id: 'not-a-uuid' }));

// 6. Unlink — leaves the live Portal showing no fabricated origin.
show('6. PATCH …/wishlist-source (unlink)', await call('PATCH', `/admin/clients/${KEN}/tasks/${task.clickup_task_id}/wishlist-source`, adminToken, { wishlist_item_id: null }));
const final = await call('GET', '/onboarding', memberToken);
const finalRow = final.json?.data?.tasks?.find((t: any) => t.clickup_task_id === task.clickup_task_id);
console.log('   after unlink:', JSON.stringify({
  source_wishlist_item_id: finalRow?.source_wishlist_item_id,
  source_wishlist_title: finalRow?.source_wishlist_title,
}));

await pool.end();
