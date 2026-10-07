import { pool } from '@infra/db/pool.js';

export const valueLedgerRepo = {
  /** The tenant's slug, the key `LEDGER_CLIENT_MAP` is written against. */
  async tenantSlug(tenantId: string): Promise<string | null> {
    const { rows } = await pool.query<{ slug: string }>(
      'select slug from core.tenants where id = $1',
      [tenantId],
    );
    return rows[0]?.slug ?? null;
  },
};
