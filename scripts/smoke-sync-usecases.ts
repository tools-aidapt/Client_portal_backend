// Throwaway: run the Case Study Library sync against the real ClickUp folder.
import 'dotenv/config';
import { pool } from '../src/infra/db/pool.js';
import { syncService } from '../src/modules/sync/clickup/sync.service.js';

const result = await syncService.syncUseCases('90129732418');
console.log('sync result:', JSON.stringify(result));
await pool.end();
