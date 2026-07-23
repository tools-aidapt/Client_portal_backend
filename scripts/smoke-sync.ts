/* Throwaway check of ClickUp task ingestion against the live DB. Inserts a
 * tenant, ingests a synthetic task, asserts the task_cache row (bucket resolved
 * from the seeded global status map), then cleans up.
 *
 * Run: npx tsx scripts/smoke-sync.ts
 */
import { syncService } from '@modules/sync/clickup/sync.service.js';
import type { ClickUpTask } from '@infra/clickup/client.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();

async function main() {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1, $2, 'active') returning id`,
    [`Sync Test Co ${stamp}`, `sync-test-${stamp}`],
  );
  const tenantId = rows[0]!.id;

  const task: ClickUpTask = {
    id: `task-${stamp}`,
    name: 'Ship the pipeline',
    status: { status: 'In Progress' }, // 'in progress' -> in_progress (global seed)
    due_date: '1731628800000',
    url: 'https://app.clickup.com/t/x',
    list: { id: 'L9', name: 'Project Delivery' },
    assignees: [{ username: 'Asha' }],
    custom_fields: [
      { id: 'cv', name: 'Client Visible', type: 'checkbox', value: true },
      { id: 'pr', name: 'Progress', type: 'number', value: 65 },
    ],
  };

  const n = await syncService.ingestTasksForTenant(tenantId, [task], 'delivery');

  const { rows: cached } = await pool.query(
    `select clickup_task_id, source, bucket, status_raw, client_visible, progress_pct,
            list_name, due_date, assignee_names
       from portal.task_cache where tenant_id = $1`,
    [tenantId],
  );
  const row = cached[0] as any;
  console.log('ingested:', n, '| row:', JSON.stringify(row));

  const pass =
    n === 1 &&
    row?.bucket === 'in_progress' &&
    row?.source === 'delivery' &&
    row?.client_visible === true &&
    Number(row?.progress_pct) === 65 &&
    Array.isArray(row?.assignee_names) &&
    row.assignee_names[0] === 'Asha';

  // Idempotency: re-ingest the same task, expect still one row.
  await syncService.ingestTasksForTenant(tenantId, [task], 'delivery');
  const { rows: after } = await pool.query(
    `select count(*)::int n from portal.task_cache where tenant_id = $1`,
    [tenantId],
  );
  const idempotent = (after[0] as any).n === 1;

  console.log(pass && idempotent ? '✅ PASS' : '❌ FAIL', '| idempotent:', idempotent);

  await pool.query(`delete from core.tenants where id = $1`, [tenantId]);
  console.log('cleaned up');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
