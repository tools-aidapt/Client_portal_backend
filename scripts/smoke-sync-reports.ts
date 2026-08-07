/**
 * Run the monthly report sync against real ClickUp Docs and print what landed.
 *
 *   npx tsx scripts/smoke-sync-reports.ts                 # every mapped tenant
 *   npx tsx scripts/smoke-sync-reports.ts --tenant <uuid>
 *   npx tsx scripts/smoke-sync-reports.ts --doc <docId>
 */
import 'dotenv/config';
import { syncService } from '../src/modules/sync/clickup/sync.service.js';
import { pool } from '../src/infra/db/pool.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const result = await syncService.syncReports({ tenantId: arg('tenant'), docId: arg('doc') });
console.log('sync:', JSON.stringify(result, null, 2));

const { rows } = await pool.query(
  `select t.name as tenant, r.title, r.period_start, r.period_end, r.status,
          r.committed_count as committed, r.delivered_count as delivered,
          r.clickup_doc_id, count(s.id)::int as sections
     from portal.reports r
     join core.tenants t on t.id = r.tenant_id
     left join portal.report_sections s on s.report_id = r.id
    group by r.id, t.name
    order by t.name, r.period_end desc, r.doc_updated_at desc nulls last`,
);
console.table(rows);

await pool.end();
