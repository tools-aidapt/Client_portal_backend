import { pool, withTransaction } from '@infra/db/pool.js';

const RESEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Reading and revoking invitations.
 *
 * `core.invitations` has always modelled a `revoked` status, and
 * `registerViaInvitation` has always refused a revoked token
 * ("Invitation was revoked") — but nothing in the codebase could ever SET it.
 * There was no list endpoint either, so 22 invitations existed that nobody
 * could see and no one could withdraw: send one to the wrong address and the
 * token stayed usable for its full 14 days.
 *
 * Tenant-scoped by construction. Every query takes `tenantId` and every write
 * is keyed on `(id, tenant_id)`, so the client-facing route (which resolves
 * the tenant from the caller's own membership) and the platform-admin route
 * (which takes it from the path) can share this without the former being able
 * to reach another client's rows.
 */

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  /** Raw column value — may say 'pending' for something already expired. */
  status: string;
  /** What the status ACTUALLY is once expiry is taken into account. */
  effective_status: 'pending' | 'accepted' | 'revoked' | 'expired';
  apps: string[];
  invited_by_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

/**
 * `status` is only advanced to 'expired' lazily, when someone tries to use the
 * token — so a row can sit at 'pending' long after `expires_at` has passed.
 * Showing that as "pending" would tell an admin an invitation is still live
 * when it is already dead, so the effective status is computed here rather
 * than left to each caller to remember.
 *
 * `apps` is cast to text[] for the same reason it is in auth.repository:
 * node-postgres has no parser for a user-defined ENUM array and would hand
 * back the raw string '{portal,lms}'.
 */
const SELECT_COLUMNS = `
  i.id,
  i.email,
  i.role::text            as role,
  i.status::text          as status,
  case
    when i.status = 'pending' and i.expires_at <= now() then 'expired'
    else i.status::text
  end                     as effective_status,
  i.apps::text[]          as apps,
  p.full_name             as invited_by_name,
  i.created_at,
  i.expires_at,
  i.accepted_at`;

export const invitationsRepo = {
  /**
   * Every invitation for a tenant, newest first. Returns accepted and revoked
   * ones too — an audit trail of who was invited and what became of it is the
   * point, not just a to-do list of outstanding ones.
   */
  /**
   * Invitations for one client.
   *
   * Only live ones by default. A client's Team page asks "who is still waiting
   * to accept" — a revoked or long-expired row answers a different question and
   * is only noise there, which is how a list of dead invitations ended up under
   * a heading that said "Nothing waiting to be accepted". Platform admins pass
   * `includeInactive` because withdrawing and re-sending is their job.
   *
   * Filtered on the EFFECTIVE status, not the stored one: `status` is only
   * advanced to 'expired' lazily, so a row can still read 'pending' well after
   * `expires_at` has passed.
   */
  async list(
    tenantId: string,
    { includeInactive = false }: { includeInactive?: boolean } = {},
  ): Promise<InvitationRow[]> {
    const { rows } = await pool.query<InvitationRow>(
      `select * from (
         select ${SELECT_COLUMNS}
           from core.invitations i
           left join core.profiles p on p.id = i.invited_by
          where i.tenant_id = $1
       ) inv
        where $2 or inv.effective_status = 'pending'
        order by inv.created_at desc`,
      [tenantId, includeInactive],
    );
    return rows;
  },

  /**
   * Withdraw a pending invitation. Returns the updated row, or null when there
   * is nothing to revoke.
   *
   * Guarded on `status = 'pending'` as well as the id, so revoking is
   * idempotent-ish and cannot rewrite history: an already-accepted invitation
   * stays 'accepted' (the person has an account — revoking the invitation
   * would neither remove it nor be true), and a second revoke is a no-op
   * rather than an error the UI has to special-case.
   *
   * Keyed on `(id, tenant_id)` so addressing another client's invitation
   * returns null — a 404 — instead of touching it.
   */
  async revoke(tenantId: string, invitationId: string): Promise<InvitationRow | null> {
    const { rows } = await pool.query<{ id: string }>(
      `update core.invitations
          set status = 'revoked'
        where id = $1 and tenant_id = $2 and status = 'pending'
        returning id`,
      [invitationId, tenantId],
    );
    if (rows.length === 0) return null;

    const { rows: full } = await pool.query<InvitationRow>(
      `select ${SELECT_COLUMNS}
         from core.invitations i
         left join core.profiles p on p.id = i.invited_by
        where i.id = $1`,
      [invitationId],
    );
    return full[0] ?? null;
  },

  /** Whether an invitation exists for this tenant at all — separates 404 from 409. */
  async statusOf(tenantId: string, invitationId: string): Promise<string | null> {
    const { rows } = await pool.query<{ status: string }>(
      `select status::text as status from core.invitations
        where id = $1 and tenant_id = $2`,
      [invitationId, tenantId],
    );
    return rows[0]?.status ?? null;
  },

  /**
   * Re-send an invitation's email. Reuses the same token rather than minting
   * a new one — the token itself never went bad, only `expires_at` did (or,
   * for a row someone already tried and failed to redeem, `status` got
   * lazily flipped to 'expired' too). Either way, resetting both back to a
   * fresh 14-day window makes the existing token valid again, so there is
   * nothing for `registerViaInvitation` or `sendInviteEmail` to reject.
   *
   * `for update` + a single transaction so two admins double-clicking Resend
   * at the same moment can't both slip past the cooldown check.
   *
   * Returns a discriminated result rather than throwing, so the controller
   * can pick the right HTTP status without a second query.
   */
  async resend(
    tenantId: string,
    invitationId: string,
  ): Promise<
    | { ok: true; token: string }
    | { ok: false; reason: 'not_found' }
    | { ok: false; reason: 'not_pending'; status: string }
    | { ok: false; reason: 'cooldown'; retryAfterSeconds: number }
  > {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{
        status: string;
        last_reminded_at: string | null;
        created_at: string;
      }>(
        `select status::text as status, last_reminded_at, created_at
           from core.invitations
          where id = $1 and tenant_id = $2
          for update`,
        [invitationId, tenantId],
      );
      const inv = rows[0];
      if (!inv) return { ok: false, reason: 'not_found' };
      if (inv.status !== 'pending' && inv.status !== 'expired') {
        return { ok: false, reason: 'not_pending', status: inv.status };
      }

      const lastSentAt = inv.last_reminded_at ?? inv.created_at;
      const elapsedMs = Date.now() - new Date(lastSentAt).getTime();
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        return {
          ok: false,
          reason: 'cooldown',
          retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000),
        };
      }

      const { rows: updated } = await client.query<{ token: string }>(
        `update core.invitations
            set status = 'pending', expires_at = now() + interval '14 days', last_reminded_at = now()
          where id = $1
          returning token`,
        [invitationId],
      );
      return { ok: true, token: updated[0]!.token };
    });
  },
};
