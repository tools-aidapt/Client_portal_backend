/* Verifies syncRepo.notifyPublishedReport against live Kenafric data:
 * emits once for the current published report, is a no-op on re-run, and
 * targets only member_pro users. Read-only apart from the notifications it
 * creates, which it reports so they can be inspected.
 *
 * Run: npx tsx scripts/smoke-report-notify.ts
 */
import { syncRepo } from '@modules/sync/clickup/sync.repository.js';
import { portalRepo } from '@modules/portal/portal.repository.js';
import { pool } from '@infra/db/pool.js';

const KENAFRIC = '01176988-95b1-44d5-851b-c5e3d52bfe66';

async function main() {
  const { rows: before } = await pool.query<{ n: number }>(
    `select count(*)::int n from core.notifications where tenant_id = $1`, [KENAFRIC]);
  console.log('notifications before:', before[0]!.n);

  const { rows: pub } = await pool.query(
    `select id, title, status, period_end from portal.reports
      where tenant_id = $1 and clickup_doc_id is not null and status = 'published'`,
    [KENAFRIC]);
  // Kenafric holds two Docs for July 2026 (a legacy duplicate), so this is
  // also the guard that exactly ONE of them is published.
  console.log('currently published report(s):', pub.length, pub.length === 1 ? '(expect 1) OK' : '(expect 1) WRONG');
  pub.forEach((r: any) => console.log(`   ${r.period_end.toISOString?.().slice(0,10) ?? r.period_end}  ${r.title}`));

  // Clear first so the emit -> no-op -> no-op sequence is actually exercised.
  // Without this the script only ever sees the idempotent branch, because a real
  // sync run will already have emitted for the current report.
  const { rowCount: cleared } = await pool.query(
    `delete from core.notifications
      where tenant_id = $1 and type = 'report_published'::core.notification_type`,
    [KENAFRIC]);
  console.log(`cleared ${cleared} existing report notification(s) to start clean`);

  const first = await syncRepo.notifyPublishedReport(KENAFRIC);
  console.log(`1st call -> emitted ${first}`);
  const second = await syncRepo.notifyPublishedReport(KENAFRIC);
  console.log(`2nd call -> emitted ${second} (expect 0, idempotent)`);
  const third = await syncRepo.notifyPublishedReport(KENAFRIC);
  console.log(`3rd call -> emitted ${third} (expect 0)`);

  const { rows: notifs } = await pool.query(
    `select n.type::text, n.title, n.link_url, m.role::text
       from core.notifications n
       join core.memberships m on m.user_id = n.user_id and m.tenant_id = n.tenant_id
      where n.tenant_id = $1 order by n.created_at`, [KENAFRIC]);
  console.log('\nnotifications now:');
  notifs.forEach((n: any) => console.log(`   [${n.role}] ${n.type}  ${n.title}  -> ${n.link_url}`));

  // The panel reads through this, per user.
  const { rows: pro } = await pool.query<{ user_id: string }>(
    `select user_id from core.memberships
      where tenant_id = $1 and status='active' and role='member_pro'`, [KENAFRIC]);
  if (pro[0]) {
    const feed = await portalRepo.notifications(pro[0].user_id, KENAFRIC);
    console.log(`\nRecent activity feed for the member_pro user: ${feed.length} item(s)`);
    feed.forEach((f: any) => console.log(`   ${new Date(f.created_at).toISOString().slice(0,10)}  ${f.title}`));
  }

  const onlyPro = notifs.every((n: any) => n.role === 'member_pro');
  const pass = first === 1 && second === 0 && third === 0 && onlyPro && pub.length === 1;
  console.log(pass ? '\n✅ PASS' : '\n❌ FAIL');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
