/**
 * Throwaway: hit the live /reports endpoints as a Kenafric MemberPro and assert
 * the monthly shape — pillars on the list, sections on the detail.
 *   npx tsx scripts/smoke-reports-api.ts
 */
import 'dotenv/config';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';
import { pool } from '../src/infra/db/pool.js';

const BASE = `http://localhost:${process.env.PORT ?? 4000}${process.env.API_PREFIX ?? '/api/v1'}`;
const TENANT = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const USER = '933d55ea-c42e-48a1-9dd4-703fa40888b9'; // member_pro on Kenafric

const token = signAccessToken(USER, 'smoke@aidapt.co', {
  platform_admin: false,
  tenant_roles: { [TENANT]: 'member_pro' },
});
const headers = { Authorization: `Bearer ${token}`, 'x-tenant-id': TENANT };

const list = await (await fetch(`${BASE}/reports`, { headers })).json();
console.log('GET /reports ->');
for (const r of list.data.items) {
  console.log(`  ${r.status.padEnd(9)} ${r.title.padEnd(28)} ${r.period_start}..${r.period_end}`,
    `| ${r.committed_count}/${r.delivered_count} | pillars=${JSON.stringify(r.pillars)}`);
}

const id = list.data.items[0].id;
const detail = (await (await fetch(`${BASE}/reports/${id}`, { headers })).json()).data;
console.log(`\nGET /reports/${id} ->`);
console.log('  title      :', detail.title);
console.log('  summary_md :', detail.summary_md?.length ?? 0, 'chars (root page only)');
console.log('  sections   :', detail.sections.length);
for (const s of detail.sections) {
  console.log(`    - ${String(s.pillar).padEnd(13)} ${s.pillar_label.padEnd(15)}`,
    `owner=${s.pillar_owner} counts=${s.committed_count}/${s.delivered_count} body=${s.body_md?.length ?? 0}`);
}

const ok =
  Array.isArray(detail.sections) &&
  detail.sections.length === 3 &&
  !detail.summary_md?.includes('Deep-Dive') &&
  !detail.summary_md?.includes('**Client:**');
console.log('\nassertions:', ok ? 'PASS' : 'FAIL');

await pool.end();
