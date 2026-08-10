import { pool } from '@infra/db/pool.js';
import type { MembershipStatus, TenantRole } from '../validators/clients.validators.js';

export interface TenantMember {
  user_id: string;
  full_name: string | null;
  /**
   * Null for anyone who has a profile + membership but no credentials row —
   * i.e. an account created by direct SQL rather than through
   * `POST /auth/register`. Real in the live DB (`Sprint Check` on Kenafric), so
   * the join has to be a LEFT one or that person vanishes from their own
   * client's member list.
   */
  email: string | null;
  role: TenantRole | 'super_admin';
  status: MembershipStatus;
  joined_at: string;
}

/** The identifying columns of one member row, shared by the read and the write. */
const MEMBER_COLUMNS = `m.user_id, p.full_name, c.email, m.role, m.status, m.joined_at`;

/**
 * Who actually belongs to one client's account, and the admin write that
 * changes a person's standing there.
 *
 * Scoped to `core` on purpose: a membership is shared identity, not Portal
 * data, so the same rows back the LMS and Support Desk views of this person.
 * Every method takes `tenantId` and filters on it — there is no "all
 * memberships" read here, because nothing should ever want one.
 */
export const membersRepo = {
  /** Every member of one tenant, by display name. */
  async list(tenantId: string): Promise<TenantMember[]> {
    const { rows } = await pool.query<TenantMember>(
      `select ${MEMBER_COLUMNS}
         from core.memberships m
         join core.profiles p on p.id = m.user_id
         left join core.user_credentials c on c.user_id = m.user_id
        where m.tenant_id = $1
        order by p.full_name asc nulls last, c.email asc nulls last`,
      [tenantId],
    );
    return rows;
  },

  /**
   * Change one member's role and/or status within one tenant. Null when that
   * person has no membership here — which is also what stops an admin editing
   * a member of a *different* client by guessing a user id, since the update
   * is keyed on the pair, not on the user alone.
   *
   * `coalesce` leaves an omitted field untouched rather than nulling it, so a
   * role-only PATCH can't silently reset someone's status.
   */
  async update(
    tenantId: string,
    userId: string,
    fields: { role?: TenantRole; status?: MembershipStatus },
  ): Promise<TenantMember | null> {
    const { rows } = await pool.query<TenantMember>(
      `with updated as (
         update core.memberships
            set role = coalesce($3::core.user_role, role),
                status = coalesce($4::core.membership_status, status)
          where tenant_id = $1 and user_id = $2
          returning user_id, role, status, joined_at
       )
       select ${MEMBER_COLUMNS}
         from updated m
         join core.profiles p on p.id = m.user_id
         left join core.user_credentials c on c.user_id = m.user_id`,
      [tenantId, userId, fields.role ?? null, fields.status ?? null],
    );
    return rows[0] ?? null;
  },

  /**
   * The stored bcrypt hash, needed only to re-push a role change to the LMS:
   * its `POST /auth/register` is an upsert that requires `password_hash` on
   * every call, and the Portal owns the credential (the LMS writes the hash
   * verbatim, never re-hashing it). Never leaves the server.
   */
  async passwordHash(userId: string): Promise<string | null> {
    const { rows } = await pool.query<{ password_hash: string }>(
      `select password_hash from core.user_credentials where user_id = $1`,
      [userId],
    );
    return rows[0]?.password_hash ?? null;
  },
};
