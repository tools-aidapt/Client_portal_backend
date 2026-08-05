/* Full end-to-end test: real ClickUp data + every HTTP endpoint.
 * Requires the server running (npm run dev). Run: npx tsx scripts/e2e.ts
 */
import 'dotenv/config';
import { pool } from '@infra/db/pool.js';
import { hashPassword } from '@modules/auth/utils/password.js';
import { supabaseAdmin } from '@infra/supabase/client.js';

const BASE = 'http://localhost:3000/api/v1';
const SECRET = process.env.INTERNAL_API_SECRET!;
const KEN_FOLDER = '901211216162';
const SPRINT_FOLDER = '901211104502';
const DELIVERY_SPACE = '90127425952';
const SPRINT_SPACE = '90127516104';
const stamp = Date.now();

const results: Array<{ name: string; status: number; ok: boolean; note?: string }> = [];
async function call(name: string, method: string, path: string, opts: { token?: string; service?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.service) headers['x-internal-secret'] = SECRET;
  const res = await fetch(BASE + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json: any = await res.json().catch(() => ({}));
  const ok = res.status >= 200 && res.status < 300;
  results.push({ name, status: res.status, ok });
  return { status: res.status, ok, json };
}

async function main() {
  // --- Setup: platform admin (direct), login over HTTP ---
  const adminPw = 'AdminPass123';
  const { rows: ap } = await pool.query<{ id: string }>(`insert into core.profiles (full_name, is_platform_admin) values ('E2E Admin', true) returning id`);
  const adminId = ap[0]!.id;
  const adminEmail = `e2e-admin-${stamp}@aidapt.co`;
  await pool.query(`insert into core.user_credentials (user_id, email, password_hash) values ($1,$2,$3)`, [adminId, adminEmail, await hashPassword(adminPw)]);
  const adminLogin = await call('POST /auth/login (admin)', 'POST', '/auth/login', { body: { email: adminEmail, password: adminPw } });
  const adminToken = adminLogin.json.data.accessToken;

  // --- Admin: onboard a client mapped to real ClickUp ---
  const reg = await call('POST /admin/clients', 'POST', '/admin/clients', {
    token: adminToken,
    body: {
      name: `E2E Client ${stamp}`,
      email_domains: [`e2e-${stamp}.example`],
      admin_email: `e2e-user-${stamp}@aidapt.co`,
      clickup_folder_id: KEN_FOLDER,
      clickup_client_group: 'Aidapt',
      sigma_ready: false,
    },
  });
  const tenantId = reg.json.data.tenantId;
  const onboardingId = reg.json.data.onboardingId;

  await call('GET /admin/clients', 'GET', '/admin/clients', { token: adminToken });
  await call('GET /admin/clients/:id/onboarding', 'GET', `/admin/clients/${tenantId}/onboarding`, { token: adminToken });
  await call('PUT /admin/clients/:id/clickup-mapping', 'PUT', `/admin/clients/${tenantId}/clickup-mapping`, { token: adminToken, body: { clickup_client_group: 'Aidapt' } });

  // --- Register the org_admin from the invitation token ---
  const { rows: inv } = await pool.query<{ token: string }>(`select token from core.invitations where tenant_id=$1 order by created_at desc limit 1`, [tenantId]);
  const userReg = await call('POST /auth/register (org_admin)', 'POST', '/auth/register', {
    body: { token: inv[0]!.token, password: 'UserPass123', fullName: 'E2E User', department: 'Ops', interests: ['ai', 'ops'] },
  });
  let userToken = userReg.json.data.accessToken;
  const userId = userReg.json.data.userId;

  // --- Pull REAL ClickUp data ---
  await call('POST /internal/sync/sprints', 'POST', '/internal/sync/sprints', { service: true, body: { sprints_folder_id: SPRINT_FOLDER } });
  const disc = await call('POST /admin/clients/:id/projects/discover', 'POST', `/admin/clients/${tenantId}/projects/discover`, { token: adminToken });
  // Make the first 3 projects client-visible.
  const projects: any[] = disc.json.data?.projects ?? [];
  for (const p of projects.slice(0, 3)) {
    await pool.query(`update portal.clickup_list_mappings set client_visible=true where tenant_id=$1 and clickup_list_id=$2`, [tenantId, p.clickup_list_id]);
  }
  await call('PATCH projects/:listId (visibility)', 'PATCH', `/admin/clients/${tenantId}/projects/${projects[0]?.clickup_list_id}`, { token: adminToken, body: { is_visible: true } });
  const syncAll = await call('POST /internal/sync/all', 'POST', '/internal/sync/all', { service: true, body: { space_ids: [DELIVERY_SPACE, SPRINT_SPACE] } });
  console.log('sync/all result:', JSON.stringify(syncAll.json.data));

  // --- Client-facing reads (org_admin passes all tiers) ---
  const me = await call('GET /auth/me', 'GET', '/auth/me', { token: userToken });
  await call('PATCH /auth/me', 'PATCH', '/auth/me', { token: userToken, body: { jobTitle: 'Head of Ops' } });
  const dash = await call('GET /dashboard', 'GET', '/dashboard', { token: userToken });
  const proj = await call('GET /projects', 'GET', '/projects', { token: userToken });
  const sprint = await call('GET /sprint/active', 'GET', '/sprint/active', { token: userToken });
  await call('GET /onboarding', 'GET', '/onboarding', { token: userToken });
  await call('GET /pod', 'GET', '/pod', { token: userToken });
  const notifs = await call('GET /notifications', 'GET', '/notifications', { token: userToken });

  // --- Wishlist ---
  await call('GET /wishlist', 'GET', '/wishlist', { token: userToken });
  const wItem = await call('POST /wishlist', 'POST', '/wishlist', { token: userToken, body: { title: 'E2E wish', description: 'test' } });
  await call('POST /wishlist/:id/vote', 'POST', `/wishlist/${wItem.json.data.id}/vote`, { token: userToken });

  // --- Reports (admin creates from active sprint, publishes; user reads + pulse) ---
  const { rows: sp } = await pool.query<{ id: string }>(`select id from portal.sprints where is_active=true order by starts_on desc limit 1`);
  const rep = await call('POST /reports', 'POST', '/reports', { token: adminToken, body: { tenant_id: tenantId, sprint_id: sp[0]?.id } });
  const reportId = rep.json.data?.id;
  await call('POST /reports/:id/publish', 'POST', `/reports/${reportId}/publish`, { token: adminToken });
  await call('GET /reports', 'GET', '/reports', { token: userToken });
  await call('GET /reports/:id', 'GET', `/reports/${reportId}`, { token: userToken });
  await call('POST /reports/:id/pulse', 'POST', `/reports/${reportId}/pulse`, { token: userToken, body: { score: 5, comment: 'great' } });

  // --- Automations ---
  await call('POST /admin/clients/:id/automations', 'POST', `/admin/clients/${tenantId}/automations`, { token: adminToken, body: { n8n_workflow_id: `wf-${stamp}`, name: 'E2E Flow', is_client_visible: true } });
  await call('GET /automations/health', 'GET', '/automations/health', { token: userToken });
  await call('POST /webhooks/n8n/execution', 'POST', '/webhooks/n8n/execution', { service: true, body: { n8n_workflow_id: `wf-${stamp}`, status: 'success', runtime_ms: 900 } });

  // --- Admin invite + notifications read + token refresh ---
  await call('POST /admin/clients/:id/invitations', 'POST', `/admin/clients/${tenantId}/invitations`, { token: adminToken, body: { email: `teammate-${stamp}@e2e.example`, role: 'member' } });
  const firstNotif = notifs.json.data?.items?.[0]?.id;
  if (firstNotif) await call('POST /notifications/:id/read', 'POST', `/notifications/${firstNotif}/read`, { token: userToken });
  const refresh = await call('POST /auth/refresh', 'POST', '/auth/refresh', { body: { refreshToken: userReg.json.data.refreshToken } });
  await call('POST /auth/logout', 'POST', '/auth/logout', { body: { refreshToken: refresh.json.data?.refreshToken } });

  // --- Report ---
  console.log('\n=== ENDPOINT RESULTS ===');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${String(r.status).padEnd(3)} ${r.name}`);
  console.log('\n=== REAL DATA ===');
  console.log('me:', me.json.data?.full_name, '| memberships:', me.json.data?.memberships?.length, '| role:', me.json.data?.memberships?.[0]?.role);
  console.log('projects total:', proj.json.data?.total, '| buckets:', JSON.stringify(Object.fromEntries(Object.entries(proj.json.data?.buckets ?? {}).map(([k, v]) => [k, (v as any[]).length]))));
  console.log('active sprint:', sprint.json.data?.sprint?.name, '| sprint tasks:', sprint.json.data?.tasks?.length);
  console.log('dashboard project counts:', JSON.stringify(dash.json.data?.projects));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✅ ALL ENDPOINTS PASSED' : `❌ ${failed.length} FAILED`} (${results.length} tested)`);

  // --- Cleanup ---
  const sprintIds = ['901218148093','901218469763','901218802642','901219147893','901219494695'];
  await pool.query(`delete from core.outbox where aggregate_id = $1 or aggregate_id in (select id from core.invitations where tenant_id=$2)`, [onboardingId, tenantId]);
  await pool.query(`update portal.reports set sprint_id=null where tenant_id=$1`, [tenantId]);
  await pool.query(`delete from core.tenants where id=$1`, [tenantId]);
  await pool.query(`delete from portal.task_cache where sprint_id = any($1::uuid[])`, [[]]).catch(() => {});
  await pool.query(`delete from portal.sprints where clickup_list_id = any($1)`, [sprintIds]);
  await pool.query(`delete from core.profiles where id in ($1,$2)`, [adminId, userId]);
  await supabaseAdmin.storage.from('avatars').remove([`${userId}/avatar.png`]).catch(() => {});
  console.log('cleaned up');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
