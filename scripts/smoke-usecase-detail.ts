// Throwaway: exercise GET /usecases and GET /usecases/:slug over real HTTP.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const { rows: t } = await pool.query<{ id: string }>(`select id from core.tenants limit 1`);
const tenant = t[0]!;
const { rows: u } = await pool.query<{ id: string }>(
  `select p.id from core.profiles p join core.memberships m on m.user_id = p.id and m.tenant_id = $1 limit 1`,
  [tenant.id],
);
const token = signAccessToken(u[0]?.id ?? tenant.id, 'probe@aidapt.co', {
  platform_admin: false,
  tenant_roles: { [tenant.id]: 'member_plus' },
});
const base = `http://localhost:${process.env.PORT ?? 4000}/api/v1`;
const h = { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id };

const list = (await (await fetch(`${base}/usecases`, { headers: h })).json()).data;
console.log('LIST -> total:', list.total, '| library rows:', list.library.length);
console.log('  keys:', Object.keys(list).join(', '), '(live must be absent)');
const niches = [...new Set(list.library.map((r: { niche: string }) => r.niche))];
console.log('  niches:', niches.join(' | '));

const slug = list.library[0].slug;
const r = await fetch(`${base}/usecases/${slug}`, { headers: h });
const x = (await r.json()).data;
console.log(`\nDETAIL /usecases/${slug} -> HTTP ${r.status}`);
console.log('  name:', x.name);
console.log('  facts:', [x.category, x.build_type, x.niche, x.business_function, x.integration_type].join(' | '));
for (const k of ['problem', 'what_gets_built', 'definition_of_done'] as const) {
  console.log(`  ${k}: ${(x[k] ?? '(null)').slice(0, 70)}…`);
}
console.log('  connects_to:', x.connects_to.length, 'items');
console.log('  body_md (fallback, expect null):', x.body_md);

console.log('\n--- access checks ---');
console.log('unknown slug        -> HTTP', (await fetch(`${base}/usecases/nope`, { headers: h })).status);
const w = await pool.query<{ slug: string }>(
  `select slug from portal.use_cases where is_published = false limit 1`,
);
const wr = await fetch(`${base}/usecases/${w.rows[0]!.slug}`, { headers: h });
console.log('withheld (non-Public) -> HTTP', wr.status, wr.status === 404 ? '✓' : '✗ MUST BE 404');
console.log('no auth               -> HTTP', (await fetch(`${base}/usecases`)).status);
await pool.end();
