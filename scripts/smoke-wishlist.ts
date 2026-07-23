/* Live end-to-end test of wishlist + voting + month-end close against the DB.
 * Run: npx tsx scripts/smoke-wishlist.ts
 */
import { wishlistService } from '@modules/wishlist/wishlist.service.js';
import { votingService } from '@modules/wishlist/voting.service.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();

async function mkUser(tenantId: string, tag: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `${tag}-${stamp}@wl.example`,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  await pool.query(
    `insert into core.memberships (user_id, tenant_id, role, status) values ($1,$2,'member_plus','active')`,
    [data.user.id, tenantId],
  );
  return data.user.id;
}

async function main() {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`WL Test ${stamp}`, `wl-test-${stamp}`],
  );
  const tenantId = rows[0]!.id;

  // Open cycle whose window has already ended (so close-cycle will pick it up).
  await pool.query(
    `insert into portal.voting_cycles (tenant_id, period_month, opens_at, closes_at, is_open)
     values ($1, date_trunc('month', now())::date, now() - interval '10 days', now() - interval '1 minute', true)`,
    [tenantId],
  );

  const u1 = await mkUser(tenantId, 'alice');
  const u2 = await mkUser(tenantId, 'bob');

  const a = await wishlistService.submit(tenantId, u1, 'Automate invoicing', 'Save finance time');
  const b = await wishlistService.submit(tenantId, u1, 'Slack alerts');
  const aId = a.id as string;
  const bId = b.id as string;

  // Votes: A gets 2 (u1, u2), B gets 1 (u1).
  await wishlistService.vote(tenantId, aId, u1);
  await wishlistService.vote(tenantId, aId, u2);
  await wishlistService.vote(tenantId, bId, u1);

  // Duplicate vote must be rejected.
  let dupRejected = false;
  try { await wishlistService.vote(tenantId, aId, u1); } catch { dupRejected = true; }

  const listed = await wishlistService.list(tenantId, u1);
  const itemA = (listed.items as any[]).find((i) => i.id === aId);
  const itemB = (listed.items as any[]).find((i) => i.id === bId);
  console.log('list:', `A votes=${itemA.votes} voted_by_me=${itemA.voted_by_me}`, `| B votes=${itemB.votes}`);
  console.log('duplicate vote rejected:', dupRejected);

  // Month-end close.
  const close = await votingService.closeDueCycles();
  const result = close.results.find((r) => r.tenantId === tenantId);
  console.log('close:', JSON.stringify(result));

  const { rows: cyc } = await pool.query(
    `select is_open, winning_item_id from portal.voting_cycles where tenant_id=$1 order by period_month`,
    [tenantId],
  );
  const { rows: st } = await pool.query(`select state from portal.wishlist_items where id=$1`, [aId]);
  const { rows: notif } = await pool.query<{ n: number }>(
    `select count(*)::int n from core.notifications where tenant_id=$1 and type='voting_results'`,
    [tenantId],
  );
  console.log('cycles:', JSON.stringify(cyc), '| winner state:', st[0].state, '| notifications:', notif[0].n);

  const pass =
    itemA.votes === 2 && itemA.voted_by_me === true && itemB.votes === 1 &&
    dupRejected &&
    result?.winnerItemId === aId && result?.votes === 2 &&
    cyc.length === 2 && cyc.some((c: any) => c.is_open === false && c.winning_item_id === aId) &&
    cyc.some((c: any) => c.is_open === true) &&
    st[0].state === 'prioritised' &&
    notif[0].n === 2;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  // Cleanup (null winner FK first so the tenant cascade can drop items).
  await pool.query(`update portal.voting_cycles set winning_item_id=null where tenant_id=$1`, [tenantId]);
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  await supabaseAdmin.auth.admin.deleteUser(u1);
  await supabaseAdmin.auth.admin.deleteUser(u2);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
