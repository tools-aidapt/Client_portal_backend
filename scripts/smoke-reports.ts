/* Live end-to-end test of reports + sprint pulse against the DB.
 * Run: npx tsx scripts/smoke-reports.ts
 */
import { reportsService } from '@modules/reports/reports.service.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();

async function main() {
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`Rep Test ${stamp}`, `rep-test-${stamp}`],
  );
  const tenantId = t[0]!.id;

  // A sprint + 5 sprint tasks (3 delivered, 2 in progress) to seed report counts.
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into portal.sprints (clickup_list_id, name, starts_on, ends_on, is_active)
     values ($1, 'Sprint 7 (test)', current_date - 14, current_date, true) returning id`,
    [`list-${stamp}`],
  );
  const sprintId = s[0]!.id;
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `insert into portal.task_cache (tenant_id, clickup_task_id, source, sprint_id, name, bucket, client_visible)
       values ($1, $2, 'sprint', $3, $4, $5, true)`,
      [tenantId, `tc-${stamp}-${i}`, sprintId, `Task ${i}`, i < 3 ? 'delivered' : 'in_progress'],
    );
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email: `pro-${stamp}@rep.example`, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  const userId = data.user.id;
  await pool.query(`insert into core.memberships (user_id, tenant_id, role, status) values ($1,$2,'member_pro','active')`, [userId, tenantId]);

  // 1. Create draft seeded from the sprint.
  const draft = await reportsService.createDraft({ tenantId, sprintId });
  console.log('draft:', `title="${draft.title}" committed=${draft.committed_count} delivered=${draft.delivered_count} status=${draft.status}`);

  // 2. Client list should NOT show the draft.
  const beforePublish = await reportsService.listForClient(tenantId);
  console.log('client sees before publish:', (beforePublish.items as unknown[]).length);

  // 3. Publish -> notifies member_pro.
  await reportsService.publish(draft.id as string, userId);
  const afterPublish = await reportsService.listForClient(tenantId);
  console.log('client sees after publish:', (afterPublish.items as unknown[]).length);

  // 4. Pulse.
  await reportsService.submitPulse(tenantId, draft.id as string, userId, 4, 'Solid sprint');
  const detail = await reportsService.getForClient(tenantId, draft.id as string, userId);
  console.log('detail my_pulse:', JSON.stringify((detail as any).my_pulse));

  // 5. Second report archives the first.
  const draft2 = await reportsService.createDraft({ tenantId, title: 'Manual report', periodStart: '2026-07-01', periodEnd: '2026-07-14' });
  await reportsService.publish(draft2.id as string, userId);
  const { rows: statuses } = await pool.query(`select status from portal.reports where tenant_id=$1 order by created_at`, [tenantId]);
  const { rows: notif } = await pool.query<{ n: number }>(`select count(*)::int n from core.notifications where tenant_id=$1 and type='report_published'`, [tenantId]);
  console.log('report statuses:', JSON.stringify(statuses.map((r: any) => r.status)), '| report_published notifs:', notif[0].n);

  const pass =
    draft.committed_count === 5 && draft.delivered_count === 3 && draft.status === 'draft' &&
    (beforePublish.items as unknown[]).length === 0 &&
    (afterPublish.items as unknown[]).length === 1 &&
    (detail as any).my_pulse?.score === 4 &&
    statuses.map((r: any) => r.status).sort().join(',') === 'archived,published' &&
    notif[0].n === 2;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  // Cleanup.
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  await pool.query(`delete from portal.sprints where id=$1`, [sprintId]);
  await supabaseAdmin.auth.admin.deleteUser(userId);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
