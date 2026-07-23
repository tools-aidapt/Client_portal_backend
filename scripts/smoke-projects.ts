/* Live end-to-end test of the project-visibility feature against real ClickUp
 * + DB, using the KEN Delivery folder. Discovers projects, toggles one visible,
 * syncs it, and asserts task_cache.client_visible reflects the toggle.
 *
 * Run: npx tsx scripts/smoke-projects.ts
 */
import { syncService } from '@modules/sync/clickup/sync.service.js';
import { syncRepo } from '@modules/sync/clickup/sync.repository.js';
import { pool } from '@infra/db/pool.js';

const KEN_FOLDER = '901211216162';
const stamp = Date.now();

async function main() {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status, clickup_folder_id)
     values ($1, $2, 'active', $3) returning id`,
    [`KEN Test ${stamp}`, `ken-test-${stamp}`, KEN_FOLDER],
  );
  const tenantId = rows[0]!.id;

  // 1. Discover projects from the KEN folder.
  const discovered = await syncService.discoverProjects(tenantId);
  const projects = await syncRepo.listProjects(tenantId);
  console.log(`discovered ${discovered.length} projects; all hidden by default:`,
    projects.every((p) => p.client_visible === false));
  projects.slice(0, 4).forEach((p) => console.log(`   ${p.clickup_list_id}  ${p.display_label}  visible=${p.client_visible}`));

  // 2. Make the first project visible, sync it.
  const target = projects[0]!;
  await syncRepo.setProjectVisibility(tenantId, target.clickup_list_id, true);
  const vis = await syncService.syncProject(tenantId, target.clickup_list_id);
  console.log(`synced visible project "${target.display_label}": upserted=${vis.upserted}, visible=${vis.visible}`);

  // 3. Sync a second project while HIDDEN (if one exists).
  const hidden = projects[1];
  let hiddenUpserted = 0;
  if (hidden) {
    const r = await syncService.syncProject(tenantId, hidden.clickup_list_id);
    hiddenUpserted = r.upserted;
    console.log(`synced hidden project "${hidden.display_label}": upserted=${r.upserted}, visible=${r.visible}`);
  }

  // 4. Assert task_cache visibility matches the project flags.
  const { rows: vRows } = await pool.query(
    `select count(*)::int total,
            count(*) filter (where client_visible)::int visible,
            count(*) filter (where not client_visible)::int not_visible
       from portal.task_cache where tenant_id = $1`,
    [tenantId],
  );
  console.log('task_cache visibility counts:', JSON.stringify(vRows[0]));

  const c = vRows[0] as any;
  const pass =
    discovered.length > 0 &&
    projects.every((p) => p.client_visible === false || p.clickup_list_id === target.clickup_list_id) &&
    (vis.upserted === 0 || c.visible === vis.upserted) &&
    (hiddenUpserted === 0 || c.not_visible === hiddenUpserted);
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.tenants where id = $1`, [tenantId]);
  console.log('cleaned up');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
