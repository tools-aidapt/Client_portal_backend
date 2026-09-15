import { pool, withTransaction } from '@infra/db/pool.js';

/** Mirrors `core.tenant_status` (migration `0040` added `suspended`). */
export type TenantStatus =
  | 'prospect'
  | 'onboarding'
  | 'active'
  | 'offboarded'
  | 'suspended';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  /**
   * Aidapt's own client group — the one tenant whose members are staff rather
   * than a customer's people. True for exactly one row.
   */
  is_protected: boolean;
  /**
   * Suspension bookkeeping, null on every tenant that is switched on. Carried
   * on the picker rows because the admin screens render the state and the
   * button label from the same fetch that already lists tenants.
   */
  suspended_at: string | null;
  suspended_by_name: string | null;
  suspension_reason: string | null;
}

const TENANT_COLUMNS = `t.id, t.name, t.slug, t.status, t.is_protected,
       t.suspended_at, t.suspension_reason,
       p.full_name as suspended_by_name`;

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
      `select ${TENANT_COLUMNS}
         from core.tenants t
         left join core.profiles p on p.id = t.suspended_by
        order by t.name asc`,
    );
    return rows;
  },

  /** One tenant, for the screens that act on a single client. Null if no such id. */
  async byId(tenantId: string): Promise<TenantSummary | null> {
    const { rows } = await pool.query<TenantSummary>(
      `select ${TENANT_COLUMNS}
         from core.tenants t
         left join core.profiles p on p.id = t.suspended_by
        where t.id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
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

  /**
   * Switch a whole client off: nobody there can sign in, and every live
   * session stops working at the next request.
   *
   * Three things happen together, so they share a transaction:
   *
   * 1. `status` becomes 'suspended' and the status it replaced is remembered.
   *    Resuming restores that, not a guessed 'active' — a tenant suspended
   *    mid-onboarding must come back as 'onboarding'.
   * 2. Every Portal refresh token held by an active member is revoked. Without
   *    this, suspension would only bite when the access token expired, leaving
   *    a ~15-minute window in which the client carried on working; and the
   *    stale refresh token would have kept minting new ones indefinitely.
   *    Scoped to `app = 'portal'` because `core.refresh_tokens` is shared with
   *    the LMS and Support Desk and those are not ours to log out.
   * 3. Platform admins are EXEMPT from the token revocation. Aidapt staff hold
   *    memberships in Aidapt's own group, and suspending anything must never
   *    be able to sign out the people who would undo it.
   *
   * Returns null when the id matches nothing, and refuses outright on the
   * protected tenant — suspending Aidapt's own group would lock every member
   * of staff out of the tool needed to lift the suspension.
   */
  async suspend(
    tenantId: string,
    actorId: string | null,
    reason: string | null,
  ): Promise<{ tenant: TenantSummary | null; sessionsRevoked: number }> {
    return withTransaction(async (client) => {
      const { rows: updated } = await client.query<{ id: string }>(
        `update core.tenants
            set status = 'suspended',
                -- status on the right-hand side is the value BEFORE this
                -- update, which is exactly the one we need to remember.
                status_before_suspension = status,
                suspended_at = now(),
                suspended_by = $2,
                suspension_reason = $3,
                updated_at = now()
          where id = $1
            and status <> 'suspended'
            and is_protected = false
          returning id`,
        [tenantId, actorId, reason],
      );
      if (updated.length === 0) return { tenant: null, sessionsRevoked: 0 };

      const { rowCount } = await client.query(
        `update core.refresh_tokens rt
            set revoked_at = now()
          where rt.app = 'portal'
            and rt.revoked_at is null
            and rt.user_id in (
              select m.user_id
                from core.memberships m
                join core.profiles p on p.id = m.user_id
               where m.tenant_id = $1
                 and m.status = 'active'
                 and p.is_platform_admin = false
            )`,
        [tenantId],
      );

      // The columns on `core.tenants` are current state and are wiped on
      // resume, so this row is the only durable record that the suspension
      // ever happened.
      await client.query(
        // `target` is the same id as `tenant_id` but passed separately: one
        // placeholder cannot be deduced as both uuid and text, which is a
        // parse-time error (42P08), not a runtime cast.
        `insert into core.audit_log (actor_id, tenant_id, action, target, metadata)
         values ($2, $1, 'tenant.suspended', $5,
                 jsonb_build_object('reason', $3::text, 'sessions_revoked', $4::int))`,
        [tenantId, actorId, reason, rowCount ?? 0, tenantId],
      );

      const { rows } = await client.query<TenantSummary>(
        `select ${TENANT_COLUMNS}
           from core.tenants t
           left join core.profiles p on p.id = t.suspended_by
          where t.id = $1`,
        [tenantId],
      );
      return { tenant: rows[0] ?? null, sessionsRevoked: rowCount ?? 0 };
    });
  },

  /**
   * Switch a client back on, restoring the lifecycle status it held before.
   *
   * `coalesce` guards the one case the check constraint cannot: a row written
   * before migration `0041` existed, or repaired by hand, could in principle
   * be 'suspended' with nothing remembered. Falling back to 'active' is right
   * for that row — a suspended tenant was, by definition, past 'prospect'.
   *
   * Sessions are NOT restored: the refresh tokens killed on suspend stay dead,
   * so everyone signs in again. That is the correct outcome — a suspension
   * long enough to matter should not leave month-old sessions springing back
   * to life — and it is also the only safe one, since a revoked token is
   * indistinguishable from one revoked for any other reason.
   *
   * Returns null when the id matches nothing or the tenant was not suspended,
   * which is what makes a double-resume a no-op rather than a status rewrite.
   */
  async resume(tenantId: string, actorId: string | null): Promise<TenantSummary | null> {
    return withTransaction(async (client) => {
      // Everything comes straight off RETURNING, not from a SELECT joined to a
      // data-modifying CTE: a CTE's writes are invisible to the rest of the
      // same statement, so that shape silently returned the PRE-resume row —
      // the update landed, but the API answered 'suspended' and the screen
      // stayed on the disabled banner until something else refetched.
      //
      // Nothing is lost by dropping the profiles join either: `suspended_by` is
      // cleared by this very update, so `suspended_by_name` is null by
      // definition on a tenant that has just been resumed.
      const { rows } = await client.query<Omit<TenantSummary, 'suspended_by_name'>>(
        `update core.tenants
            set status = coalesce(status_before_suspension, 'active'::core.tenant_status),
                status_before_suspension = null,
                suspended_at = null,
                suspended_by = null,
                suspension_reason = null,
                updated_at = now()
          where id = $1
            and status = 'suspended'
        returning id, name, slug, status, is_protected,
                  suspended_at, suspension_reason`,
        [tenantId],
      );
      const row = rows[0];
      if (!row) return null;

      await client.query(
        // Separate placeholder for `target`, same reason as in `suspend`.
        `insert into core.audit_log (actor_id, tenant_id, action, target, metadata)
         values ($2, $1, 'tenant.resumed', $4,
                 jsonb_build_object('restored_to', $3::text))`,
        [tenantId, actorId, row.status, tenantId],
      );
      return { ...row, suspended_by_name: null };
    });
  },
};
