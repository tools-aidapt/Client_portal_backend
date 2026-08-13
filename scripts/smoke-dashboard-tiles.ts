/* Live check of the three Dashboard tiles that were reading empty.
 *
 * All three failed for different reasons and all three are silent failures —
 * they render as "nothing to see" rather than as an error, which is why they
 * sat broken. This calls the real service layer against the live DB.
 *
 *   sprint   — the sprint ClickUp list is only populated for some tenants, so
 *              a tenant with real in-window delivery work showed "In sprint: 0"
 *   lms      — bridged only by email domain, and several tenants have NO row
 *              in core.tenant_email_domains at all
 *   support  — read a summary table nothing has updated since onboarding
 *
 * Read-only: asserts, writes nothing, cleans nothing up.
 *
 * Run: npx tsx scripts/smoke-dashboard-tiles.ts
 */
import 'dotenv/config';
import { portalService } from '../src/modules/portal/portal.service.js';
import { pool } from '../src/infra/db/pool.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { rows: tenants } = await pool.query<{ id: string; name: string; slug: string }>(
    `select id, name, slug from core.tenants order by name`,
  );
  const ken = tenants.find((t) => t.slug === 'kenafric');
  if (!ken) throw new Error('Kenafric tenant not found');

  const { rows: u } = await pool.query<{ user_id: string }>(
    `select m.user_id from core.memberships m where m.tenant_id = $1 and m.status = 'active' limit 1`,
    [ken.id],
  );
  const userId = u[0]?.user_id;
  if (!userId) throw new Error('no active Kenafric member to render a dashboard as');

  const dash = await portalService.dashboard(ken.id, userId);

  console.log('\n--- Kenafric dashboard ---');
  console.log('sprint:', dash.sprint.sprint ? (dash.sprint.sprint as { name: string }).name : 'none');
  console.log('sprint tasks:', dash.sprint.tasks.length);
  console.log('lms tile   :', JSON.stringify(dash.tiles.lms));
  console.log('support    :', JSON.stringify(dash.tiles.support));

  console.log('\n--- assertions ---');
  check('sprint tile is not empty', dash.sprint.tasks.length > 0, `${dash.sprint.tasks.length} tasks`);
  check('LMS tile is not null', dash.tiles.lms !== null);
  check(
    'LMS tile reports real learners',
    ((dash.tiles.lms as { active_learners?: number } | null)?.active_learners ?? 0) > 0,
    `active_learners=${(dash.tiles.lms as { active_learners?: number } | null)?.active_learners}`,
  );
  check('support tile is not null', dash.tiles.support !== null);
  const open = (dash.tiles.support as { open_tickets?: number } | null)?.open_tickets ?? 0;
  check('support tile reports real open tickets', open > 0, `open_tickets=${open}`);

  // The support tile must agree with Support Desk's own table, not a cached copy.
  const { rows: truth } = await pool.query<{ n: string }>(
    `select count(*) n from support.sd_tickets
      where client_id = $1 and status in ('open', 'in_progress')`,
    [ken.id],
  );
  check('support tile matches live sd_tickets', String(open) === truth[0]!.n, `tile=${open} db=${truth[0]!.n}`);

  // Every tenant should render without throwing, and tiles should stay null
  // (hidden) rather than fabricating zeros where there is genuinely no presence.
  console.log('\n--- all tenants ---');
  for (const t of tenants) {
    const { rows: m } = await pool.query<{ user_id: string }>(
      `select user_id from core.memberships where tenant_id = $1 and status='active' limit 1`,
      [t.id],
    );
    if (!m[0]) { console.log(`  ${t.name.padEnd(24)} (no members — skipped)`); continue; }
    const d = await portalService.dashboard(t.id, m[0].user_id);
    console.log(
      `  ${t.name.padEnd(24)} sprint=${String(d.sprint.tasks.length).padStart(3)}  ` +
        `lms=${d.tiles.lms ? 'yes' : 'null'}  support=${d.tiles.support ? JSON.stringify(d.tiles.support) : 'null'}`,
    );
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
