/* Live end-to-end test of the client-facing Portal reads (step 4) against real
 * ClickUp + DB. Sets up a tenant + member, syncs a visible project, then calls
 * the Portal service (projects, dashboard, notifications) and cleans up.
 *
 * Run: npx tsx scripts/smoke-portal.ts
 */
import { syncService } from '@modules/sync/clickup/sync.service.js';
import { syncRepo } from '@modules/sync/clickup/sync.repository.js';
import { portalService } from '@modules/portal/portal.service.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
import { pool } from '@infra/db/pool.js';

const KEN_FOLDER = '901211216162';
const stamp = Date.now();
const email = `member@portal-${stamp}.example`;

async function main() {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status, clickup_folder_id)
     values ($1, $2, 'active', $3) returning id`,
    [`Portal Test ${stamp}`, `portal-test-${stamp}`, KEN_FOLDER],
  );
  const tenantId = rows[0]!.id;

  // A member_pro user in this tenant.
  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser failed');
  const userId = data.user.id;
  await pool.query(
    `insert into core.memberships (user_id, tenant_id, role, status) values ($1,$2,'member_pro','active')`,
    [userId, tenantId],
  );

  // Seed the support tile + a notification. (lms.tenant_enablement_summary no
  // longer exists — the LMS team replaced that schema — so the LMS tile is null.)
  await pool.query(`insert into support.tenant_support_summary (tenant_id, open_tickets, breached_sla) values ($1, 3, 1)`, [tenantId]);
  const { rows: nrows } = await pool.query<{ id: string }>(
    `insert into core.notifications (tenant_id, user_id, type, title) values ($1,$2,'report_published','Q3 report is live') returning id`,
    [tenantId, userId],
  );
  const notifId = nrows[0]!.id;

  // Discover + make one project visible + sync it.
  const projects = await syncService.discoverProjects(tenantId);
  const target = projects[0]!;
  await syncRepo.setProjectVisibility(tenantId, target.listId, true);
  const synced = await syncService.syncProject(tenantId, target.listId);

  // --- Portal reads ---
  const proj = await portalService.projects(tenantId);
  const dash = await portalService.dashboard(tenantId, userId);
  const notifsBefore = await portalService.notifications(userId, tenantId);
  await portalService.markNotificationRead(notifId, userId);
  const notifsAfter = await portalService.notifications(userId, tenantId);

  console.log('projects total:', proj.total, '| buckets:',
    Object.fromEntries(Object.entries(proj.buckets).map(([k, v]) => [k, (v as unknown[]).length])));
  console.log('dashboard.projects counts:', JSON.stringify(dash.projects));
  console.log('dashboard.tiles.lms:', JSON.stringify(dash.tiles.lms), '| support:', JSON.stringify(dash.tiles.support));
  console.log('dashboard unread:', dash.notifications.unread);
  console.log('notifications unread before/after read:', notifsBefore.unread, '/', notifsAfter.unread);

  const pass =
    proj.total === synced.upserted &&
    proj.total > 0 &&
    dash.tiles.lms === null && // LMS table removed by the LMS team -> graceful null
    dash.tiles.support !== null &&
    notifsBefore.unread === 1 &&
    notifsAfter.unread === 0;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.notifications where tenant_id=$1`, [tenantId]);
  await supabaseAdmin.auth.admin.deleteUser(userId);
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  console.log('cleaned up');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
