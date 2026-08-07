/**
 * Throwaway: run the report-Doc sync against the real Kenafric Project Pack.
 *   npx tsx scripts/smoke-sync-reports.ts [docId]
 */
import 'dotenv/config';
import { syncService } from '../src/modules/sync/clickup/sync.service.js';
import { pool } from '../src/infra/db/pool.js';

const docId = process.argv[2] ?? '8ckbtec-180492'; // KEN - RET - DOS - Project Pack

const result = await syncService.syncReports(docId);
console.log(JSON.stringify(result, null, 2));
await pool.end();
