import pg from 'pg';
import { config } from '@config/index.js';
import { isProduction } from '@config/env.js';
import { logger } from '@infra/logger/index.js';

/**
 * Direct Postgres pool for privileged, transactional server operations
 * (e.g. atomic client onboarding). Connects as the database owner, so it is
 * NOT bound by RLS — use only in trusted server code.
 *
 * User-facing reads that must respect RLS go through the request-scoped
 * Supabase client (`req.auth.db`), not this pool.
 */
export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  // Supabase requires TLS; the pooler/host cert is not in the local trust store.
  ssl: { rejectUnauthorized: false },
  max: isProduction ? 10 : 4,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle Postgres client error');
});

export type Queryable = pg.PoolClient | pg.Pool;

/**
 * Runs `fn` inside a single transaction, committing on success and rolling
 * back on any thrown error. The callback receives a dedicated client that must
 * be used for every statement in the transaction.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
