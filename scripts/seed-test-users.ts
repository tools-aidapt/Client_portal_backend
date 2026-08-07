/**
 * Seeds one dummy client user per role, per tenant, for Portal testing.
 *
 * Writes core.profiles + core.user_credentials + core.memberships directly,
 * mirroring exactly what `authRepo.registerViaInvitation` does — deliberately
 * NOT going through the invitation flow, because creating invitations posts to
 * the LIVE n8n invite webhook and would email real people.
 *
 * Idempotent: an email that already exists is left untouched and reported as
 * `skipped`, so re-running never duplicates or silently resets a password.
 *
 * `super_admin` is never granted here — it sets `is_platform_admin` and would
 * turn a "client" into cross-tenant Aidapt staff. These are all client roles.
 *
 * Run:    npx tsx scripts/seed-test-users.ts
 * Undo:   npx tsx scripts/seed-test-users.ts --revert
 */
import 'dotenv/config';
import { pool, withTransaction } from '../src/infra/db/pool.js';
import { hashPassword } from '../src/modules/auth/utils/password.js';

/** Shared across every seeded account — these are throwaway test logins. */
const PASSWORD = 'AidaptPortal!Test2026';

/** Client-facing roles only, lowest → highest. */
const ROLES = [
  { role: 'member', local: 'member.test', title: 'Operations Analyst' },
  { role: 'member_plus', local: 'plus.test', title: 'Operations Manager' },
  { role: 'member_pro', local: 'pro.test', title: 'Head of Operations' },
  { role: 'org_admin', local: 'admin.test', title: 'Programme Owner' },
] as const;

/** Domain derived from the tenant's own slug — not an invented corporate fact. */
function domainFor(slug: string): string {
  return `${slug.replace(/-/g, '')}.com`;
}

function displayName(tenantName: string, role: string): string {
  const label = role.replace('member_', '').replace('_', ' ');
  return `${tenantName} ${label.charAt(0).toUpperCase()}${label.slice(1)} (Test)`;
}

const revert = process.argv.includes('--revert');

const { rows: tenants } = await pool.query<{ id: string; name: string; slug: string }>(
  `select id, name, slug from core.tenants order by name`,
);

if (revert) {
  const emails = tenants.flatMap((t) => ROLES.map((r) => `${r.local}@${domainFor(t.slug)}`));
  const { rows } = await pool.query<{ user_id: string }>(
    `select user_id from core.user_credentials where lower(email) = any($1::text[])`,
    [emails.map((e) => e.toLowerCase())],
  );
  const ids = rows.map((r) => r.user_id);
  if (ids.length === 0) {
    console.log('Nothing to revert.');
  } else {
    await withTransaction(async (client) => {
      await client.query(`delete from core.memberships where user_id = any($1::uuid[])`, [ids]);
      await client.query(`delete from core.user_credentials where user_id = any($1::uuid[])`, [ids]);
      await client.query(`delete from core.refresh_tokens where user_id = any($1::uuid[])`, [ids]);
      await client.query(`delete from core.profiles where id = any($1::uuid[])`, [ids]);
    });
    console.log(`Reverted ${ids.length} seeded test users.`);
  }
  await pool.end();
  process.exit(0);
}

const passwordHash = await hashPassword(PASSWORD);
const created: Array<Record<string, string>> = [];
let skipped = 0;

for (const tenant of tenants) {
  for (const { role, local, title } of ROLES) {
    const email = `${local}@${domainFor(tenant.slug)}`;

    const exists = await pool.query(
      `select 1 from core.user_credentials where lower(email) = lower($1)`,
      [email],
    );
    if ((exists.rowCount ?? 0) > 0) {
      skipped += 1;
      continue;
    }

    await withTransaction(async (client) => {
      const prof = await client.query<{ id: string }>(
        `insert into core.profiles (full_name, job_title, is_platform_admin)
         values ($1, $2, false)
         returning id`,
        [displayName(tenant.name, role), title],
      );
      const userId = prof.rows[0]!.id;
      await client.query(
        `insert into core.user_credentials (user_id, email, password_hash) values ($1, $2, $3)`,
        [userId, email, passwordHash],
      );
      await client.query(
        `insert into core.memberships (user_id, tenant_id, role, status)
         values ($1, $2, $3::core.user_role, 'active')`,
        [userId, tenant.id, role],
      );
    });

    created.push({ tenant: tenant.name, role, email });
  }
}

console.table(created);
console.log(`\ncreated: ${created.length}   skipped (already existed): ${skipped}`);
console.log(`password for every seeded account: ${PASSWORD}`);
await pool.end();
