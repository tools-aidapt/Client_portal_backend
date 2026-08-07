// Throwaway: confirm /pod returns real per-lead booking URLs with topic prefill.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const { rows } = await pool.query<{ id: string; name: string }>(
  `select id, name from core.tenants where name = 'Kenafric' limit 1`,
);
const t = rows[0]!;
const token = signAccessToken(t.id, 'probe@aidapt.co', {
  platform_admin: false,
  tenant_roles: { [t.id]: 'member_plus' },
});
const r = await fetch('http://localhost:4000/api/v1/pod', {
  headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': t.id },
});
const d = (await r.json()).data;
console.log(`GET /pod -> HTTP ${r.status} | members: ${d.members.length}`);
for (const m of d.members) {
  console.log(`  ${m.display_name.padEnd(24)}${m.role_label.padEnd(22)}${m.booking_url ? 'BOOKABLE' : 'no calendar'}`);
  if (m.booking_url) {
    const u = new URL(m.booking_url);
    u.searchParams.set('notes', 'Use case: AI Driver Dispatch & Fleet Route Optimisation System');
    console.log(`      opens -> ${u.toString()}`);
  }
}
await pool.end();
