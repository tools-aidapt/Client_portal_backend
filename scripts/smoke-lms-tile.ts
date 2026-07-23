/* Validate the live LMS tile against the LMS team's real data. Creates a Portal
 * tenant whose email domain (hbl.com) matches an LMS client group, reads the
 * tile, and cleans up.
 *
 * Run: npx tsx scripts/smoke-lms-tile.ts
 */
import { portalRepo } from '@modules/portal/portal.repository.js';
import { pool } from '@infra/db/pool.js';

const stamp = Date.now();

async function main() {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1, $2, 'active') returning id`,
    [`LMS Tile Test ${stamp}`, `lms-tile-${stamp}`],
  );
  const tenantId = rows[0]!.id;
  // hbl.com maps to the "HBL Bank" LMS client group (2 users, 2 courses).
  await pool.query(
    `insert into core.tenant_email_domains (tenant_id, domain) values ($1, 'hbl.com')`,
    [tenantId],
  );

  const tile = await portalRepo.enablementSummary(tenantId);
  console.log('LMS tile for hbl.com:', JSON.stringify(tile));

  // A tenant with no matching LMS group -> null tile.
  const { rows: r2 } = await pool.query<{ id: string }>(
    `insert into core.tenants (name, slug, status) values ($1, $2, 'active') returning id`,
    [`No LMS ${stamp}`, `no-lms-${stamp}`],
  );
  await pool.query(`insert into core.tenant_email_domains (tenant_id, domain) values ($1, $2)`, [
    r2[0]!.id,
    `nolms-${stamp}.example`,
  ]);
  const none = await portalRepo.enablementSummary(r2[0]!.id);
  console.log('LMS tile for unmatched domain:', JSON.stringify(none));

  const pass =
    tile !== null &&
    (tile.active_learners as number) === 2 &&
    (tile.courses_assigned as number) === 2 &&
    none === null;
  console.log(pass ? '✅ PASS' : '❌ FAIL');

  await pool.query(`delete from core.tenants where id in ($1, $2)`, [tenantId, r2[0]!.id]);
  console.log('cleaned up');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
