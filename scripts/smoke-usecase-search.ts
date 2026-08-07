// Throwaway: exercise search, filters and facets on GET /usecases.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const { rows: t } = await pool.query<{ id: string }>(`select id from core.tenants limit 1`);
const tenant = t[0]!;
const token = signAccessToken(tenant.id, 'probe@aidapt.co', {
  platform_admin: false,
  tenant_roles: { [tenant.id]: 'member_plus' },
});
const base = `http://localhost:${process.env.PORT ?? 4000}/api/v1`;
const h = { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id };

async function get(qs: string) {
  const r = await fetch(`${base}/usecases${qs}`, { headers: h });
  return { status: r.status, body: (await r.json()).data };
}

for (const qs of [
  '',
  '?q=insurance',
  '?q=insur',
  '?q=freight invoice audit',
  '?q=whatsapp',
  '?q=reduce manual invoice processing time',
  '?niche=Insurance',
  '?q=claims&niche=Insurance',
  '?category=Operations&build_type=Agent',
  '?q=%2B%2B%2B---%26%26',
  '?q=zzzznomatch',
]) {
  const { status, body } = await get(qs);
  const label = qs || '(browse all)';
  console.log(
    `${String(status)} ${label.padEnd(46)} matched=${String(body.matched).padStart(3)}/${body.total}` +
      `  search_applied=${body.query.search_applied}` +
      `  top="${body.library[0]?.name?.slice(0, 44) ?? '—'}"`,
  );
}

console.log('\n--- snippet (why it matched) ---');
const s = await get('?q=fraud');
console.log(s.body.library[0].name);
console.log(' ', s.body.library[0].snippet);

console.log('\n--- facets for q=insurance ---');
const f = await get('?q=insurance');
for (const dim of ['niche', 'category', 'build_type'] as const) {
  console.log(
    ` ${dim}:`,
    f.body.facets[dim].map((x: { value: string; count: number }) => `${x.value}(${x.count})`).join(' '),
  );
}
await pool.end();
