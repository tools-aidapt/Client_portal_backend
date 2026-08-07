/* Live check of the Sprint Line read after re-scoping sprintTasks() from
 * `source='sprint' and sprint_id` (always empty — the per-sprint ClickUp list
 * is never populated) to delivery tasks due inside the active sprint's window.
 *
 * Read-only. Run: npx tsx scripts/smoke-sprint-line.ts
 */
import { portalService } from '@modules/portal/portal.service.js';
import { portalRepo } from '@modules/portal/portal.repository.js';
import { pool } from '@infra/db/pool.js';

const KENAFRIC = '01176988-95b1-44d5-851b-c5e3d52bfe66';

async function main() {
  const sprint = await portalRepo.activeSprint();
  console.log('activeSprint:', JSON.stringify(sprint));
  console.log('starts_on runtime type:', Object.prototype.toString.call(sprint?.starts_on));

  const res = await portalService.sprintActive(KENAFRIC);
  console.log(`sprintActive -> ${res.tasks.length} tasks`);
  for (const t of res.tasks) {
    console.log(`   ${String(t.due_date)}  ${t.bucket ?? '(no bucket)'}  ${String(t.name).slice(0, 55)}`);
  }

  // Cross-check against the same window computed independently in SQL.
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int n
       from portal.task_cache tc
      where tc.tenant_id = $1 and tc.source = 'delivery' and tc.client_visible = true
        and tc.due_date between (select starts_on from portal.sprints where is_active limit 1)
                            and (select ends_on   from portal.sprints where is_active limit 1)`,
    [KENAFRIC],
  );
  const expected = rows[0]!.n;
  console.log(`SQL cross-check expects ${expected}`);

  // Null-date guard: no window means no filter, so it must not fall back to
  // returning the whole backlog.
  const guarded = await portalRepo.sprintTasks(KENAFRIC, null, sprint?.ends_on ?? null);
  console.log(`null starts_on -> ${guarded.length} tasks (expect 0)`);

  const pass = res.tasks.length === expected && expected > 0 && guarded.length === 0;
  console.log(pass ? '✅ PASS' : '❌ FAIL');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
