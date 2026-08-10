// Throwaway: a token carrying a pre-0031 role must 401 (refreshable), not 403.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const { rows } = await pool.query<{ id: string; name: string; uid: string; role: string }>(
  `select t.id, t.name, p.id as uid, m.role
     from core.tenants t
     join core.memberships m on m.tenant_id = t.id
     join core.profiles p on p.id = m.user_id
    where t.name = 'Tile & Carpet Centre' and p.full_name like '%Org admin%' limit 1`,
);
const r = rows[0]!;
console.log(`user: ${r.uid}  tenant: ${r.name}  DB role: ${r.role}\n`);

const base = 'http://localhost:4000/api/v1';
async function probe(label: string, role: string) {
  const token = signAccessToken(r.uid, 'admin.test@tilecarpetcentre.com', {
    platform_admin: false,
    tenant_roles: { [r.id]: role },
  });
  const res = await fetch(`${base}/usecases`, {
    headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': r.id },
  });
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  console.log(
    `${label.padEnd(30)} HTTP ${res.status}  ${body.error?.code ?? 'OK'}  ${body.error?.message ?? ''}`,
  );
}

// Retired names that a pre-migration token can still carry:
await probe('claims: org_admin (stale)', 'org_admin');
await probe('claims: member_plus (stale)', 'member_plus');
await probe('claims: member_pro (stale)', 'member_pro');
// Current names:
await probe('claims: admin (current)', 'admin');
await probe('claims: member (too low)', 'member');
await pool.end();
