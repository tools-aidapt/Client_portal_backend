import { pool, withTransaction } from '@infra/db/pool.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '@common/errors/index.js';

export interface MembershipView {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: string;
  status: string;
}

export interface MeView {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  locale: string | null;
  is_platform_admin: boolean;
  memberships: MembershipView[];
}

export const authRepo = {
  /**
   * Own profile + active memberships. Filtered strictly by the authenticated
   * user id, so reading via the (RLS-bypassing) pool is safe here.
   */
  async getMe(userId: string): Promise<MeView | null> {
    const { rows } = await pool.query<MeView>(
      `select p.id, p.full_name, p.avatar_url, p.job_title, p.locale, p.is_platform_admin,
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'tenant_id', m.tenant_id, 'tenant_name', t.name,
                    'tenant_slug', t.slug, 'role', m.role, 'status', m.status
                  ) order by t.name
                ) filter (where m.id is not null),
                '[]'::jsonb
              ) as memberships
         from core.profiles p
         left join core.memberships m on m.user_id = p.id and m.status = 'active'
         left join core.tenants t on t.id = m.tenant_id
        where p.id = $1
        group by p.id`,
      [userId],
    );
    return rows[0] ?? null;
  },

  /**
   * Accept an invitation for the authenticated user (design §9.3).
   * Matches by email, creates/updates the membership, marks the invite accepted
   * — all in one transaction. Returns the tenant and granted role.
   */
  async acceptInvitation(
    userId: string,
    userEmail: string,
    token: string,
  ): Promise<{ tenantId: string; role: string }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
        role: string;
        status: string;
        invited_by: string | null;
        expired: boolean;
      }>(
        `select id, tenant_id, email, role, status, invited_by,
                (expires_at <= now()) as expired
           from core.invitations
          where token = $1
          for update`,
        [token],
      );

      const inv = rows[0];
      if (!inv) throw new NotFoundError('Invitation not found');
      if (inv.status === 'revoked') throw new ForbiddenError('Invitation was revoked');
      if (inv.status === 'accepted') throw new BadRequestError('Invitation already used');
      if (inv.status === 'expired' || inv.expired) {
        await client.query(
          `update core.invitations set status = 'expired' where id = $1 and status = 'pending'`,
          [inv.id],
        );
        throw new BadRequestError('Invitation expired');
      }
      if (inv.email.toLowerCase() !== userEmail.toLowerCase()) {
        throw new ForbiddenError('This invitation was issued to a different email address');
      }

      // Ensure a profile row exists (normally created by the auth trigger).
      await client.query(
        `insert into core.profiles (id) values ($1) on conflict (id) do nothing`,
        [userId],
      );

      await client.query(
        `insert into core.memberships (user_id, tenant_id, role, status, invited_by)
         values ($1, $2, $3::core.user_role, 'active', $4)
         on conflict (user_id, tenant_id)
         do update set role = excluded.role, status = 'active'`,
        [userId, inv.tenant_id, inv.role, inv.invited_by],
      );

      await client.query(
        `update core.invitations set status = 'accepted', accepted_at = now() where id = $1`,
        [inv.id],
      );

      await client.query(
        `insert into core.audit_log (actor_id, tenant_id, action, target, metadata)
         values ($1, $2, 'invitation.accepted', $3, jsonb_build_object('invitation_id', $3::text, 'role', $4::text))`,
        [userId, inv.tenant_id, inv.id, inv.role],
      );

      return { tenantId: inv.tenant_id, role: inv.role };
    });
  },
};
