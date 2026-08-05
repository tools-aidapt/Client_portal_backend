/* Live test of automation health: register, client health, execution webhook,
 * error notification. Run: npx tsx scripts/smoke-automation.ts
 */
import { automationService } from '@modules/automation/automation.service.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();
const wfId = `wf-${stamp}`;

async function main() {
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1,$2,'active') returning id`,
    [`Auto Co ${stamp}`, `auto-co-${stamp}`],
  );
  const tenantId = t[0]!.id;

  // A member_plus user to receive error notifications.
  const { rows: p } = await pool.query<{ id: string }>(`insert into core.profiles (full_name) values ('Ops') returning id`);
  const userId = p[0]!.id;
  await pool.query(`insert into core.memberships (user_id, tenant_id, role, status) values ($1,$2,'member_plus','active')`, [userId, tenantId]);

  // Register a client-visible workflow.
  await automationService.register({ tenantId, n8nWorkflowId: wfId, name: 'Invoice Sync', isClientVisible: true });
  const h0 = await automationService.clientHealth(tenantId);
  const w0 = (h0.workflows as any[])[0];

  // Success execution.
  const r1 = await automationService.recordExecution(wfId, 'success', 1200);
  const h1 = (await automationService.clientHealth(tenantId)).workflows as any[];

  // Error execution -> state error + notification.
  const r2 = await automationService.recordExecution(wfId, 'error', 800);
  const h2 = (await automationService.clientHealth(tenantId)).workflows as any[];
  const { rows: n } = await pool.query<{ c: number }>(`select count(*)::int c from core.notifications where tenant_id=$1 and type='automation_error'`, [tenantId]);

  // Unregistered workflow -> no-op.
  const r3 = await automationService.recordExecution('does-not-exist', 'success', null);

  console.log('initial state:', w0?.state, '| after success:', h1[0]?.state, 'exec=', h1[0]?.executions_this_month, 'avg=', h1[0]?.avg_runtime_ms);
  console.log('after error:', h2[0]?.state, 'exec=', h2[0]?.executions_this_month, 'errors=', h2[0]?.errors_this_month, '| notifications=', n[0].c);
  console.log('updates:', r1.updated, r2.updated, '| unregistered updated:', r3.updated);

  const pass =
    w0?.state === 'idle' &&
    h1[0]?.state === 'active' && h1[0]?.executions_this_month === 1 && Number(h1[0]?.avg_runtime_ms) === 1200 &&
    h2[0]?.state === 'error' && h2[0]?.executions_this_month === 2 && h2[0]?.errors_this_month === 1 &&
    n[0].c === 1 &&
    r1.updated === 1 && r2.updated === 1 && r3.updated === 0;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  await pool.query(`delete from core.profiles where id=$1`, [userId]);
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
