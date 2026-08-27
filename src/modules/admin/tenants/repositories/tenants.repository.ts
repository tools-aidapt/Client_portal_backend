import { pool } from '@infra/db/pool.js';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  /**
   * Aidapt's own client group — the one tenant whose members are staff rather
   * than a customer's people. True for exactly one row.
   */
  is_protected: boolean;
}

export const adminTenantsRepo = {
  /**
   * Every tenant, for the Portal's admin tenant picker. Deliberately the
   * identifying columns only — the picker sends the id back as `x-tenant-id`
   * and shows the name, so commercial/routing fields have no reason to be here.
   *
   * `is_protected` is here because the Users screen has to know whether it may
   * offer `super_admin` at all, and that is a property of the tenant being
   * viewed, not of the member row.
   */
  async list(): Promise<TenantSummary[]> {
    const { rows } = await pool.query<TenantSummary>(
      `select id, name, slug, status, is_protected
         from core.tenants
        order by name asc`,
    );
    return rows;
  },

  /**
   * Is this Aidapt's own client group?
   *
   * The single question behind every `super_admin` grant: platform-wide staff
   * access may only be given to someone who belongs to Aidapt, so a client's
   * own tenant can never mint one no matter which endpoint is called. Reads
   * `is_protected` rather than matching the name or slug — a rename must not
   * silently open or close a permission gate.
   *
   * Returns false for a tenant id that doesn't exist, so a bad id fails closed.
   */
  async isInternal(tenantId: string): Promise<boolean> {
    const { rows } = await pool.query<{ is_protected: boolean }>(
      `select is_protected from core.tenants where id = $1`,
      [tenantId],
    );
    return rows[0]?.is_protected === true;
  },
};
