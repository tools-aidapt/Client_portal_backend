/* Live check of the Sync Console backend.
 *
 * Exercises the read model, the advisory lock, and one real streamed run
 * against ClickUp. Runs the FAST entity ('sprints') on purpose — the full
 * spaces walk and the ~600-study use-case library are the slow ones and are
 * not what this is testing.
 *
 * Run: npx tsx scripts/smoke-sync-console.ts
 */
import 'dotenv/config';
import { syncConsoleService, SYNC_ENTITIES } from '../src/modules/admin/sync/sync-console.service.js';
import { syncConsoleRepo } from '../src/modules/admin/sync/sync-console.repository.js';
import { pool } from '../src/infra/db/pool.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { rows: admins } = await pool.query<{ id: string; full_name: string }>(
    `select id, full_name from core.profiles where is_platform_admin limit 1`,
  );
  const admin = admins[0];
  if (!admin) throw new Error('no platform admin to attribute a run to');

  // ---- 1. overview ----
  console.log('\n1. overview');
  const ov = await syncConsoleService.overview();
  check('entity catalogue complete', ov.entities.length === SYNC_ENTITIES.length, `${ov.entities.length} entities`);
  check('folder stats returned', ov.folders.length > 0, `${ov.folders.length} tenants`);
  check('list stats returned', ov.lists.length > 0, `${ov.lists.length} mapped lists`);
  check('totals populated', (ov.totals.tasks ?? 0) > 0, JSON.stringify(ov.totals));
  const ken = ov.folders.find((f) => f.tenant_name === 'Kenafric');
  console.log('   Kenafric:', JSON.stringify(ken));
  console.log('   entities:');
  for (const e of ov.entities) {
    console.log(
      `     ${e.key.padEnd(12)} last=${e.last?.last_status ?? 'never'} ` +
        `upserted=${e.last?.last_upserted ?? '-'} at=${e.last?.last_started_at ?? '-'}`,
    );
  }

  // ---- 2. advisory lock ----
  console.log('\n2. advisory lock');
  const first = await syncConsoleRepo.acquireLock('smoke_entity');
  check('first acquire wins', first !== null);
  const second = await syncConsoleRepo.acquireLock('smoke_entity');
  check('second acquire is refused while held', second === null);
  await first!.release();
  const third = await syncConsoleRepo.acquireLock('smoke_entity');
  check('acquire succeeds again after release', third !== null);
  await third!.release();

  // ---- 3. a real streamed run ----
  console.log('\n3. live streamed run (sprints — the fast one)');
  const events: Array<{ phase: string; message: string }> = [];
  const started = Date.now();
  const result = await syncConsoleService.runEntity('sprints', admin.id, (e) => {
    events.push(e);
    console.log(`     [${e.phase}] ${e.message}`);
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  check('run returned a result', !!result, `upserted=${result.upserted} in ${secs}s`);
  check('progress events were emitted', events.length > 0, `${events.length} events`);
  check('a terminal done event was emitted', events.some((e) => e.phase === 'done'));

  // ---- 4. the run is recorded and attributed ----
  console.log('\n4. sync_runs bookkeeping');
  const { rows: runRows } = await pool.query<{
    status: string; records_upserted: number; triggered_by: string | null; finished_at: string | null;
  }>(
    `select status::text, records_upserted, triggered_by, finished_at
       from portal.sync_runs where entity = 'sprints' order by started_at desc limit 1`,
  );
  const run = runRows[0]!;
  check('row is no longer running', run.status !== 'running', `status=${run.status}`);
  check('finished_at is set', run.finished_at !== null);
  check('attributed to the admin who ran it', run.triggered_by === admin.id, `by ${admin.full_name}`);

  // ---- 5. cron path unchanged (no ctx => no attribution, still works) ----
  console.log('\n5. cron path still works without a context');
  const { rows: before } = await pool.query<{ n: string }>(`select count(*) n from portal.sync_runs`);
  const { syncService } = await import('../src/modules/sync/clickup/sync.service.js');
  const cronRun = await syncService.refreshSprints();
  const { rows: after } = await pool.query<{ n: string }>(`select count(*) n from portal.sync_runs`);
  check('unattributed cron-style run succeeds', cronRun.upserted >= 0, `upserted=${cronRun.upserted}`);
  check('it recorded a run row', Number(after[0]!.n) === Number(before[0]!.n) + 1);
  const { rows: cronRow } = await pool.query<{ triggered_by: string | null }>(
    `select triggered_by from portal.sync_runs where entity='sprints' order by started_at desc limit 1`,
  );
  check('cron run has no triggered_by', cronRow[0]!.triggered_by === null);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
