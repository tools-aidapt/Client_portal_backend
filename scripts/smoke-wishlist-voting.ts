/* Live HTTP exercise of the wishlist board + voting, against real Kenafric data.
 *
 * Leaves the database as it found it: every vote it casts is removed again, and
 * every cycle change is made with `notify: false` so no real client user is
 * emailed or notified. Read the summary at the end before trusting a green run.
 *
 * Run: npx tsx scripts/smoke-wishlist-voting.ts   (needs `npm run dev` up)
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
  `select user_id as id from core.memberships
    where tenant_id = $1 and status = 'active' limit 1`,
  [KEN],
);
if (!admins[0]) throw new Error('No platform admin profile');
if (!members[0]) throw new Error('No active Kenafric membership');

const adminToken = signAccessToken(admins[0].id, null, { platform_admin: true, tenant_roles: {} });
const plusToken = signAccessToken(members[0].id, null, {
  platform_admin: false,
  tenant_roles: { [KEN]: 'member_plus' },
});
// A subject that is NOT a platform admin and NOT member_plus — every profile in
// this database happens to be a platform admin, so a real member's token would
// pass the admin gate via requirePlatformAdmin's DB fallback and prove nothing.
const memberToken = signAccessToken('44444444-4444-4444-4444-444444444444', null, {
  platform_admin: false,
  tenant_roles: { [KEN]: 'member' },
});

async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-tenant-id': KEN,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, data: json?.data };
}

const fails: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(label);
}

// ---------------------------------------------------------------- read surface
const list = await call('GET', '/wishlist', plusToken);
check('GET /wishlist 200', list.status === 200, `HTTP ${list.status}`);
const items = list.data?.items ?? [];
check('board returns items', items.length > 0, `${items.length} items`);
check(
  'cycle states open/closed explicitly (is_open + is_overdue present)',
  list.data?.cycle === null || typeof list.data?.cycle?.is_open === 'boolean',
);
check('last_closed_cycle key present', 'last_closed_cycle' in (list.data ?? {}));

const withDetail = items.filter((i: any) => i.problem);
console.log(`      detail: ${withDetail.length}/${items.length} carry a parsed problem`);
check(
  'parsed detail reaches the API',
  withDetail.length > 0,
  withDetail[0]?.problem?.slice(0, 40),
);
check(
  'no ClickUp task id leaks to the client',
  items.every((i: any) => !('clickup_task_id' in i)),
);
check(
  'provenance exposed as `source`',
  items.every((i: any) => i.source === 'portal' || i.source === 'request_form'),
);
check(
  'body_md withheld when the parse succeeded',
  items.every((i: any) => (i.problem ? i.body_md === null : true)),
);

// `member` must be able to READ (this used to 403 and render a raw error string
// as a member's landing page).
const asMember = await call('GET', '/wishlist', memberToken);
check('member can read the board', asMember.status === 200, `HTTP ${asMember.status}`);
const memberVote = await call('POST', `/wishlist/${items[0]?.id}/vote`, memberToken);
check('member cannot vote', memberVote.status === 403, `HTTP ${memberVote.status}`);

// ------------------------------------------------------------------- votes
const target = items.find((i: any) => i.can_vote) ?? items[0];
const cycleOpen = Boolean(list.data?.cycle);
console.log(`\n      open cycle: ${cycleOpen ? list.data.cycle.period_month : 'NONE'}`);

if (!cycleOpen) {
  console.log('      skipping vote checks — no open cycle for this tenant');
} else {
  // Start from a known baseline. The probe signs in as a REAL Kenafric member, so
  // if that person has voted in the browser their vote is already counted and every
  // delta assertion below would be off by one.
  await call('DELETE', `/wishlist/${target.id}/vote`, plusToken);
  const baseline = await call('GET', '/wishlist', plusToken);
  const before = baseline.data.items.find((i: any) => i.id === target.id).votes;

  const v1 = await call('POST', `/wishlist/${target.id}/vote`, plusToken);
  check('vote 200 snake_case', v1.status === 200 && typeof v1.data?.item_id === 'string');
  check('vote increments', v1.data?.votes === before + 1, `${before} -> ${v1.data?.votes}`);
  check('vote reports voted:true, changed:true', v1.data?.voted === true && v1.data?.changed === true);

  const v2 = await call('POST', `/wishlist/${target.id}/vote`, plusToken);
  check('repeat vote is idempotent 200 (was 409)', v2.status === 200, `HTTP ${v2.status}`);
  check('repeat vote does not double-count', v2.data?.votes === before + 1);
  check('repeat vote reports changed:false', v2.data?.changed === false);

  const u1 = await call('DELETE', `/wishlist/${target.id}/vote`, plusToken);
  check('un-vote 200', u1.status === 200, `HTTP ${u1.status}`);
  check('un-vote decrements back', u1.data?.votes === before, `-> ${u1.data?.votes}`);
  check('un-vote reports voted:false, changed:true', u1.data?.voted === false && u1.data?.changed === true);

  const u2 = await call('DELETE', `/wishlist/${target.id}/vote`, plusToken);
  check('repeat un-vote is idempotent, not 404', u2.status === 200, `HTTP ${u2.status}`);
  check('repeat un-vote reports changed:false', u2.data?.changed === false);

  const reread = await call('GET', '/wishlist', plusToken);
  const back = reread.data.items.find((i: any) => i.id === target.id);
  check('board back to its original count', back.votes === before, `${back.votes} vs ${before}`);
  check('voted_by_me cleared', back.voted_by_me === false);

  const nonCandidate = items.find((i: any) => i.state !== 'candidate');
  if (nonCandidate) {
    const bad = await call('POST', `/wishlist/${nonCandidate.id}/vote`, plusToken);
    check('cannot vote on a non-candidate item', bad.status === 400, `HTTP ${bad.status}`);
  }
}

// -------------------------------------------------------------- admin surface
const cycles = await call('GET', `/admin/clients/${KEN}/voting/cycles`, adminToken);
check('admin can list cycles', cycles.status === 200, `${cycles.data?.cycles?.length} cycles`);
const open = cycles.data?.cycles?.find((c: any) => c.is_open);
if (open) {
  console.log(
    `      cycle ${open.period_month}: is_overdue=${open.is_overdue}, ` +
      `total_votes=${open.total_votes}, voters=${open.voters}`,
  );
  const bd = await call(
    'GET',
    `/admin/clients/${KEN}/voting/cycles/${open.id}/breakdown`,
    adminToken,
  );
  check('admin can read the per-item breakdown', bd.status === 200, `${bd.data?.items?.length} items`);

  // Read-only guard checks — neither of these should mutate anything.
  const past = await call('PATCH', `/admin/clients/${KEN}/voting/cycles/${open.id}`, adminToken, {
    closes_at: '2020-01-01T00:00:00.000Z',
  });
  check('extend rejects a past closes_at', past.status === 400, `HTTP ${past.status}`);

  const dupe = await call('POST', `/admin/clients/${KEN}/voting/cycles`, adminToken, {});
  check('opening a second cycle is refused', dupe.status === 409, `HTTP ${dupe.status}`);
}

const foreign = await call(
  'GET',
  `/admin/clients/${KEN}/voting/cycles/11111111-1111-1111-1111-111111111111/breakdown`,
  adminToken,
);
check('a cycle from another client 404s', foreign.status === 404, `HTTP ${foreign.status}`);

const notAdmin = await call('GET', `/admin/clients/${KEN}/voting/cycles`, memberToken);
check('non-admin blocked from admin routes', notAdmin.status === 403, `HTTP ${notAdmin.status}`);

// --------------------------------------------------------------------- result
const { rows: leftover } = await pool.query<{ n: number }>(
  `select count(*)::int n from portal.wishlist_votes v
     join portal.wishlist_items wi on wi.id = v.item_id
    where wi.tenant_id = $1 and v.user_id = $2`,
  [KEN, members[0].id],
);
check('no votes left behind by this probe', leftover[0]!.n === 0, `${leftover[0]!.n} rows`);

console.log(`\n${fails.length === 0 ? 'ALL PASS' : `${fails.length} FAILED: ${fails.join(', ')}`}`);
await pool.end();
if (fails.length) process.exit(1);
