import { pool } from '@infra/db/pool.js';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export const adminTenantsRepo = {
  /**
   * Every tenant, for the Portal's admin tenant picker. Deliberately the four
   * identifying columns only — the picker sends the id back as `x-tenant-id`
   * and shows the name, so commercial/routing fields have no reason to be here.
   */
  async list(): Promise<TenantSummary[]> {
    const { rows } = await pool.query<TenantSummary>(
      `select id, name, slug, status
         from core.tenants
        order by name asc`,
    );
    return rows;
  },
};
