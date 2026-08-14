import { pool, withTransaction } from '@infra/db/pool.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@common/errors/index.js';
import type { AccessClaims } from '../utils/tokens.js';

export interface CredentialRow {
  user_id: string;
  email: string;
  password_hash: string;
}

export interface MembershipView {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: string;
  status: string;
}

export interface ProfileFields {
  fullName?: string;
  jobTitle?: string;
  department?: string;
  phone?: string;
  avatarUrl?: string;
  interests?: string[];
  locale?: string;
}

export interface MeView {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  phone: string | null;
  interests: string[] | null;
  locale: string | null;
  is_platform_admin: boolean;
  memberships: MembershipView[];
}

export const authRepo = {
  /**
   * Create a profile + credentials pair in one transaction. Throws
   * ConflictError if the email is already registered (case-insensitive).
   */
  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName?: string;
  }): Promise<{ userId: string }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into core.profiles (full_name) values ($1) returning id`,
        [input.fullName ?? null],
      );
      const userId = rows[0]!.id;
      try {
        await client.query(
          `insert into core.user_credentials (user_id, email, password_hash)
           values ($1, $2, $3)`,
          [userId, input.email, input.passwordHash],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError('Email already registered');
        }
        throw err;
      }
      return { userId };
    });
  },

  /**
   * Invitation-gated registration. Validates the invite token, creates the
   * profile + credentials (email taken from the invite so the user can't pick a
   * different one), grants membership in the invited tenant/role, and marks the
   * invitation accepted — all atomically. Returns identity + granted membership.
   */
  async registerViaInvitation(input: {
    token: string;
    passwordHash: string;
    profile: ProfileFields;
  }): Promise<{ userId: string; email: string; tenantId: string; role: string; apps: string[] }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
        role: string;
        status: string;
        invited_by: string | null;
        apps: string[] | null;
        expired: boolean;
      }>(
        // `apps` is cast to text[] deliberately. It is declared
        // `core.app_type[]`, and node-postgres ships no parser for a
        // user-defined ENUM array, so it hands back the RAW string
        // '{portal,lms,support_desk}' rather than an array. The caller spreads
        // this value (`[...inv.apps]`), which on a string spreads it into
        // individual CHARACTERS — producing ['{','p','o',…] and then failing
        // with `invalid input value for enum core.app_type: "{"`. That made
        // every invitation registration a 500. A plain text[] has a built-in
        // parser and comes back as a real array, so the cast is the whole fix.
        `select id, tenant_id, email, role, status, invited_by,
                apps::text[] as apps,
                (expires_at <= now()) as expired
           from core.invitations where token = $1 for update`,
        [input.token],
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

      const existing = await client.query(
        `select 1 from core.user_credentials where lower(email) = lower($1)`,
        [inv.email],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictError(
          'An account with this email already exists — sign in and accept the invitation instead',
        );
      }

      // A super_admin invitation also grants the platform-admin flag.
      const p = input.profile;
      const prof = await client.query<{ id: string }>(
        `insert into core.profiles
           (full_name, job_title, department, phone, avatar_url, interests, locale, is_platform_admin)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, 'en'), $8)
         returning id`,
        [
          p.fullName ?? null, p.jobTitle ?? null, p.department ?? null, p.phone ?? null,
          p.avatarUrl ?? null, p.interests ?? null, p.locale ?? null,
          inv.role === 'super_admin',
        ],
      );
      const userId = prof.rows[0]!.id;
      await client.query(
        `insert into core.user_credentials (user_id, email, password_hash) values ($1, $2, $3)`,
        [userId, inv.email, input.passwordHash],
      );
      await client.query(
        `insert into core.memberships (user_id, tenant_id, role, status, invited_by)
         values ($1, $2, $3::core.user_role, 'active', $4)`,
        [userId, inv.tenant_id, inv.role, inv.invited_by],
      );
      await client.query(
        `update core.invitations set status = 'accepted', accepted_at = now() where id = $1`,
        [inv.id],
      );
      // Grant exactly the apps the inviter chose, in the same transaction that
      // creates the account — so a half-provisioned user cannot exist. Portal is
      // always included: the invitation is to the Portal, and an account that
      // cannot open it has nowhere to accept from.
      const apps = Array.from(new Set(['portal', ...(inv.apps ?? [])]));
      await client.query(
        `insert into core.app_access (user_id, app, status, granted_by)
         select $1, unnest($2::core.app_type[]), 'active', $3
         on conflict (user_id, app)
           do update set status = 'active', revoked_at = null`,
        [userId, apps, inv.invited_by],
      );

      await client.query(
        `insert into core.audit_log (actor_id, tenant_id, action, target, metadata)
         values ($1, $2, 'invitation.registered', $3,
                 jsonb_build_object('invitation_id', $3::text, 'role', $4::text,
                                    'apps', to_jsonb($5::text[])))`,
        [userId, inv.tenant_id, inv.id, inv.role, apps],
      );

      return { userId, email: inv.email, tenantId: inv.tenant_id, role: inv.role, apps };
    });
  },

  /** Look up credentials by email (case-insensitive). */
  async findCredentialsByEmail(email: string): Promise<CredentialRow | null> {
    const { rows } = await pool.query<CredentialRow>(
      `select user_id, email, password_hash
         from core.user_credentials
        where lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  },

  /** Look up a user's email by id (used when reissuing tokens on refresh). */
  async getEmailByUserId(userId: string): Promise<string | null> {
    const { rows } = await pool.query<{ email: string }>(
      `select email from core.user_credentials where user_id = $1`,
      [userId],
    );
    return rows[0]?.email ?? null;
  },

  /**
   * Store a freshly issued OTP code. Any previously issued, still-live codes
   * for the user are consumed first so only the latest one is ever valid.
   */
  async createOtpCode(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `update core.otp_codes set consumed_at = now()
          where user_id = $1 and consumed_at is null`,
        [userId],
      );
      await client.query(
        `insert into core.otp_codes (user_id, code_hash, expires_at) values ($1, $2, $3)`,
        [userId, codeHash, expiresAt],
      );
    });
  },

  /** The user's current live (unconsumed, unexpired) OTP code, if any. */
  async findActiveOtpCode(
    userId: string,
  ): Promise<{ id: string; codeHash: string; attempts: number } | null> {
    const { rows } = await pool.query<{ id: string; code_hash: string; attempts: number }>(
      `select id, code_hash, attempts from core.otp_codes
        where user_id = $1 and consumed_at is null and expires_at > now()
        order by created_at desc
        limit 1`,
      [userId],
    );
    const row = rows[0];
    return row ? { id: row.id, codeHash: row.code_hash, attempts: row.attempts } : null;
  },

  /** Record a failed verification attempt against an OTP code. */
  async incrementOtpAttempts(id: string): Promise<void> {
    await pool.query(`update core.otp_codes set attempts = attempts + 1 where id = $1`, [id]);
  },

  /** Mark an OTP code used so it can't be replayed. */
  async consumeOtpCode(id: string): Promise<void> {
    await pool.query(`update core.otp_codes set consumed_at = now() where id = $1`, [id]);
  },

  /**
   * Authorization claims for a user: platform-admin flag + active tenant roles.
   * Embedded into the access token at sign-in / refresh.
   */
  async getAccessClaims(userId: string): Promise<AccessClaims> {
    const [p, m] = await Promise.all([
      pool.query<{ is_platform_admin: boolean }>(
        `select is_platform_admin from core.profiles where id = $1`,
        [userId],
      ),
      pool.query<{ tenant_id: string; role: string }>(
        `select tenant_id, role from core.memberships
          where user_id = $1 and status = 'active'`,
        [userId],
      ),
    ]);
    return {
      platform_admin: p.rows[0]?.is_platform_admin === true,
      tenant_roles: Object.fromEntries(m.rows.map((r) => [r.tenant_id, r.role])),
    };
  },

  /**
   * Persist a hashed refresh token.
   *
   * `app` is stamped 'portal' on every row. `core.refresh_tokens` is shared
   * with LMS and Support Desk (migration `0036`), so a session that doesn't
   * name its issuer can't be told apart from theirs — and every query below
   * filters on it. Hardcoded rather than a parameter: this repository only
   * ever issues Portal sessions.
   */
  async storeRefreshToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string;
  }): Promise<void> {
    await pool.query(
      `insert into core.refresh_tokens (user_id, token_hash, expires_at, user_agent, app)
       values ($1, $2, $3, $4, 'portal')`,
      [input.userId, input.tokenHash, input.expiresAt, input.userAgent ?? null],
    );
  },

  /**
   * Find a live (unrevoked, unexpired) refresh token by its hash.
   *
   * The `app` filter is a semantic guard, not a security one — `token_hash`
   * carries a global unique index, so another app's row could never be
   * returned here anyway. It keeps this query honest about what it means once
   * three apps share the table: "this Portal session", not "some session".
   */
  async findActiveRefreshToken(
    tokenHash: string,
  ): Promise<{ id: string; userId: string } | null> {
    const { rows } = await pool.query<{ id: string; user_id: string }>(
      `select id, user_id from core.refresh_tokens
        where token_hash = $1 and app = 'portal'
          and revoked_at is null and expires_at > now()`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { id: row.id, userId: row.user_id } : null;
  },

  /** Revoke a single Portal refresh token by hash. Returns true if one was revoked. */
  async revokeRefreshToken(tokenHash: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `update core.refresh_tokens set revoked_at = now()
        where token_hash = $1 and app = 'portal' and revoked_at is null`,
      [tokenHash],
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * Revoke every live PORTAL refresh token for a user (logout-everywhere).
   *
   * Scoped to `app = 'portal'` deliberately: "log me out everywhere" issued
   * from the Portal ends the user's Portal sessions, and does NOT silently
   * sign them out of LMS and Support Desk, whose rows now live in this same
   * table. A genuine cross-app kill is a different operation and would have to
   * drop the `app` filter on purpose.
   */
  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await pool.query(
      `update core.refresh_tokens set revoked_at = now()
        where user_id = $1 and app = 'portal' and revoked_at is null`,
      [userId],
    );
  },

  /**
   * Own profile + active memberships. Filtered strictly by the authenticated
   * user id, so reading via the (RLS-bypassing) pool is safe here.
   */
  async getMe(userId: string): Promise<MeView | null> {
    const { rows } = await pool.query<MeView>(
      `select p.id, p.full_name, p.avatar_url, p.job_title, p.department, p.phone,
              p.interests, p.locale, p.is_platform_admin,
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
   * The apps this identity may open, read from core.app_access — the single
   * place that answers the question for all three products.
   *
   * `/auth/me` used to return a hardcoded ['portal','lms','support'] to anyone
   * with a membership or the platform-admin flag, so the Portal offered every
   * app to everyone and no per-app grant could ever be expressed.
   *
   * The enum stores `support_desk`; the API has always said `support`, and the
   * frontend reads that, so the name is mapped here rather than changing a
   * published contract.
   */
  async listActiveApps(userId: string): Promise<Array<'portal' | 'lms' | 'support'>> {
    const { rows } = await pool.query<{ app: string }>(
      `select app::text as app
         from core.app_access
        where user_id = $1 and status = 'active'
        order by app`,
      [userId],
    );
    return rows.map((r) => (r.app === 'support_desk' ? 'support' : r.app)) as Array<
      'portal' | 'lms' | 'support'
    >;
  },

  /** Update editable profile fields (null = leave unchanged). Returns fresh /me. */
  async updateProfile(userId: string, f: ProfileFields): Promise<MeView | null> {
    await pool.query(
      `update core.profiles set
         full_name  = coalesce($2, full_name),
         job_title  = coalesce($3, job_title),
         department = coalesce($4, department),
         phone      = coalesce($5, phone),
         avatar_url = coalesce($6, avatar_url),
         interests  = coalesce($7, interests),
         locale     = coalesce($8, locale)
       where id = $1`,
      [
        userId, f.fullName ?? null, f.jobTitle ?? null, f.department ?? null,
        f.phone ?? null, f.avatarUrl ?? null, f.interests ?? null, f.locale ?? null,
      ],
    );
    return this.getMe(userId);
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
