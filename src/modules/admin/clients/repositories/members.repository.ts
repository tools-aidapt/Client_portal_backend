import { pool, withTransaction } from '@infra/db/pool.js';
import type {
  AssignableRole,
  MembershipStatus,
  TenantRole,
} from '../validators/clients.validators.js';

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
  /**
   * Which of the three products this person may open, from core.app_access.
   * Aggregated here so the member list can render access without an N+1.
   */
  apps: string[];
}

/** The identifying columns of one member row, shared by the read and the write. */
const MEMBER_COLUMNS = `m.user_id, p.full_name, c.email, m.role, m.status, m.joined_at,
       coalesce(
         (select array_agg(aa.app::text order by aa.app)
            from core.app_access aa
           where aa.user_id = m.user_id and aa.status = 'active'),
         '{}'
       ) as apps`;

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
  /**
   * Members of one client.
   *
   * Suspended memberships are hidden by default. A client's own Team page is
   * the roster of who works there now — a suspended row is someone who has been
   * removed, and showing them as if they were staff was how retired demo
   * accounts ended up visible to real clients. Platform admins pass
   * `includeSuspended` because they need to see one in order to restore it.
   */
  async list(
    tenantId: string,
    { includeSuspended = false }: { includeSuspended?: boolean } = {},
  ): Promise<TenantMember[]> {
    const { rows } = await pool.query<TenantMember>(
      `select ${MEMBER_COLUMNS}
         from core.memberships m
         join core.profiles p on p.id = m.user_id
         left join core.user_credentials c on c.user_id = m.user_id
        where m.tenant_id = $1
          and ($2 or m.status <> 'suspended')
        order by p.full_name asc nulls last, c.email asc nulls last`,
      [tenantId, includeSuspended],
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
    fields: { role?: AssignableRole; status?: MembershipStatus },
  ): Promise<TenantMember | null> {
    return withTransaction(async (client) => {
      // Read before writing: the flag update below has to know what the role
      // WAS, not just what it became.
      const before = await client.query<{ role: string }>(
        `select role::text as role from core.memberships
          where tenant_id = $1 and user_id = $2 for update`,
        [tenantId, userId],
      );
      const previousRole = before.rows[0]?.role ?? null;

      const { rows } = await client.query<TenantMember>(
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
      const member = rows[0] ?? null;
      if (!member || !fields.role || fields.role === previousRole) return member;

      // `super_admin` and `profiles.is_platform_admin` are two halves of one
      // fact and must move together: `requirePlatformAdmin` reads the flag, not
      // the role, so a promotion that only wrote the role would show the badge
      // while every admin screen still said no, and a demotion would leave
      // platform access behind entirely. Registration set the flag from a
      // `super_admin` invitation and nothing kept them in step afterwards.
      //
      // Deliberately narrow: only a transition INTO or OUT OF `super_admin`
      // touches the flag. Aidapt staff predating this hold `admin` plus the
      // flag directly, and a member↔admin change — including re-picking the
      // role a person already has — must not quietly revoke that.
      if (fields.role === 'super_admin') {
        await client.query(`update core.profiles set is_platform_admin = true where id = $1`, [
          userId,
        ]);
      } else if (previousRole === 'super_admin') {
        await client.query(`update core.profiles set is_platform_admin = false where id = $1`, [
          userId,
        ]);
      }
      return member;
    });
  },

  /**
   * Replace which apps one member may open, as an exact set: anything in
   * `apps` becomes active, anything else they currently hold is revoked.
   *
   * Keyed on the (tenant, user) PAIR like `update` above, so a tenant admin
   * cannot reach a member of another client by guessing a user id. Returns null
   * when the person is not a member here, which is what enforces that.
   *
   * Portal used to be forced into `apps` on every call, so it could be granted
   * and never taken away. The argument was that an account which cannot open
   * the Portal has no way back in to be re-granted anything — but that is a
   * statement about who may make the change, not about whether the state is
   * expressible, and the person re-granting it is an admin on a different
   * account. Meanwhile the grant it protected did nothing: no sign-in path read
   * `core.app_access` for 'portal' at all, so the one app whose access could
   * not be revoked was also the one whose access was never checked. Both halves
   * are fixed together — this method now honours an exact set, and the auth
   * gate (`authRepo.portalAccessState`) makes the revocation bite.
   *
   * The guards that stopped a revoke stranding someone live in the callers,
   * where the identity of the admin doing it is known: see `teamController`
   * and `membersController`.
   */
  async setAppAccess(
    tenantId: string,
    userId: string,
    apps: string[],
    grantedBy: string | null,
  ): Promise<TenantMember | null> {
    const belongs = await pool.query(
      `select 1 from core.memberships where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    if ((belongs.rowCount ?? 0) === 0) return null;

    const wanted = Array.from(new Set(apps));

    await withTransaction(async (client) => {
      await client.query(
        `insert into core.app_access (user_id, app, status, granted_by)
         select $1, unnest($2::core.app_type[]), 'active', $3
         on conflict (user_id, app)
           do update set status = 'active', revoked_at = null, granted_by = excluded.granted_by`,
        [userId, wanted, grantedBy],
      );
      await client.query(
        `update core.app_access
            set status = 'revoked', revoked_at = now()
          where user_id = $1
            and status = 'active'
            and not (app = any($2::core.app_type[]))`,
        [userId, wanted],
      );
    });

    const { rows } = await pool.query<TenantMember>(
      `select ${MEMBER_COLUMNS}
         from core.memberships m
         join core.profiles p on p.id = m.user_id
         left join core.user_credentials c on c.user_id = m.user_id
        where m.tenant_id = $1 and m.user_id = $2`,
      [tenantId, userId],
    );
    return rows[0] ?? null;
  },

  /**
   * One member of one tenant, in the same shape as `list`. Null when that
   * person has no membership here — which is also what keeps a guess at
   * another client's user id from resolving.
   */
  async byId(tenantId: string, userId: string): Promise<TenantMember | null> {
    const { rows } = await pool.query<TenantMember>(
      `select ${MEMBER_COLUMNS}
         from core.memberships m
         join core.profiles p on p.id = m.user_id
         left join core.user_credentials c on c.user_id = m.user_id
        where m.tenant_id = $1 and m.user_id = $2`,
      [tenantId, userId],
    );
    return rows[0] ?? null;
  },

  /**
   * How many OTHER people could still administer this client's Portal if the
   * given person lost their Portal access right now.
   *
   * Counts an active membership, an admin-grade role, and a live `portal`
   * grant together, because all three are required to be of any use: a
   * suspended admin cannot sign in, and an admin without the app cannot open
   * the screen where access is handed back.
   *
   * Backs the last-admin guard on the client's own Team page. Aidapt's
   * equivalent endpoint deliberately does NOT consult this — see
   * `membersController.setApps`.
   */
  async otherActivePortalAdmins(tenantId: string, excludingUserId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from core.memberships m
         join core.app_access aa
           on aa.user_id = m.user_id and aa.app = 'portal' and aa.status = 'active'
        where m.tenant_id = $1
          and m.user_id <> $2
          and m.status = 'active'
          and m.role in ('admin', 'super_admin')`,
      [tenantId, excludingUserId],
    );
    return Number(rows[0]?.count ?? 0);
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
