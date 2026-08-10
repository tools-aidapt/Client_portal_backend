// Throwaway: confirm the full catalogue is served, capped and pageable.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const { rows } = await pool.query<{ id: string }>(`select id from core.tenants limit 1`);
const t = rows[0]!;
const token = signAccessToken(t.id, 'probe@aidapt.co', {
  platform_admin: false,
  tenant_roles: { [t.id]: 'member_plus' },
});
const h = { Authorization: `Bearer ${token}`, 'x-tenant-id': t.id };

async function get(qs: string) {
  const r = await fetch(`http://localhost:4000/api/v1/usecases${qs}`, { headers: h });
  return { status: r.status, d: (await r.json()).data };
}

for (const qs of ['', '?limit=120', '?limit=600', '?q=invoice', '?niche=Insurance', '?limit=0', '?limit=9999']) {
  const { status, d } = await get(qs);
  if (status !== 200) {
    console.log(`${status} ${(qs || '(default)').padEnd(18)} rejected (${d?.error?.code ?? 'error'})`);
    continue;
  }
  console.log(
    `${status} ${(qs || '(default)').padEnd(18)} total=${d.total} matched=${String(d.matched).padStart(3)}` +
      ` returned=${String(d.returned).padStart(3)} has_more=${d.has_more} limit=${d.query.limit}`,
  );
}

console.log('\n--- facets now span every list ---');
const { d } = await get('');
console.log(' industries:', d.facets.niche.length, '| categories:', d.facets.category.length,
  '| build types:', d.facets.build_type.map((x: {value:string;count:number}) => `${x.value}(${x.count})`).join(' '));
await pool.end();
