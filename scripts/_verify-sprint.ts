/* TEMP verification: creates a Kenafric member_plus user, hits the LIVE running
 * backend over HTTP, prints the sprint panel payload. Leaves the user in place
 * for a browser check; scripts/_verify-cleanup.ts removes it. */
import { pool } from '@infra/db/pool.js';
import { hashPassword } from '@modules/auth/utils/password.js';

const KENAFRIC = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const BASE = 'http://localhost:4000/api/v1';
const EMAIL = 'sprintcheck@aidapt.co';
const PW = 'SprintCheck123';

async function main() {
  await pool.query(`delete from core.user_credentials where email = $1`, [EMAIL]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.profiles (full_name) values ('Sprint Check') returning id`,
  );
  const uid = rows[0]!.id;
  await pool.query(
    `insert into core.user_credentials (user_id, email, password_hash) values ($1,$2,$3)`,
    [uid, EMAIL, await hashPassword(PW)],
  );
  await pool.query(
    `insert into core.memberships (tenant_id, user_id, role, status) values ($1,$2,'member_plus','active')`,
    [KENAFRIC, uid],
  );
  console.log('temp user id:', uid);

  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  }).then((r) => r.json());
  const token = login.data.accessToken;

  for (const path of ['/dashboard', '/sprint/active']) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': KENAFRIC },
    });
    const body = await res.json();
    const s = path === '/dashboard' ? body.data.sprint : body.data;
    console.log(`\n${path} -> ${res.status}`);
    console.log('  sprint:', s.sprint?.name, s.sprint?.starts_on, '->', s.sprint?.ends_on);
    console.log('  tasks :', s.tasks.length);
    s.tasks.forEach((t: any) => console.log(`     ${String(t.due_date).slice(0,10)}  ${t.bucket ?? '-'}  ${String(t.name).slice(0,50)}`));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
