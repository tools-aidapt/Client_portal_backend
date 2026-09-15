import type { RequestHandler } from 'express';
import { AppError, BadRequestError, ForbiddenError, UnauthorizedError } from '@common/errors/index.js';
import { asyncHandler } from '@common/utils/async-handler.js';
import { pool } from '@infra/db/pool.js';
import { ROLE_RANK, meetsRole, type RoleName } from '@common/constants/roles.js';

interface Resolved {
  roles: Record<string, string>; // tenantId -> role
  /** tenantId -> whether that tenant is currently switched off. */
  suspendedTenants: Set<string>;
  isAdmin: boolean;
  /** Live `core.app_access` grant for 'portal'. */
  hasPortalAccess: boolean;
}

/**
 * Resolve the caller's tenant roles from `core.memberships` — the live record,
 * deliberately NOT the `tenant_roles` claim in the access token.
 *
 * The claim is stamped when the token is issued and then frozen for the token's
 * whole lifetime, so changing someone's role left the app answering on the old
 * one until they signed in again. That is not just stale, it is *incoherently*
 * stale: `/auth/me` reads the database, so the Portal drew the navigation for
 * the new role while every request behind it was still judged on the old one.
 * Promoting a Tile & Carpet Centre user to `admin` gave them the Onboarding page
 * with "Requires role admin" printed on it. A demotion has the same shape and
 * worse consequences: access the person no longer has, held until their token
 * expires.
 *
 * The cost is one indexed lookup per request, on endpoints that all hit the
 * database anyway; the claim stays in the token for debugging but no longer
 * decides anything here.
 */
async function resolveRoles(userId: string): Promise<Resolved> {
  const { rows } = await pool.query<{
    is_platform_admin: boolean;
    has_portal_access: boolean;
    tenant_id: string | null;
    role: string | null;
    tenant_suspended: boolean | null;
  }>(
    `select p.is_platform_admin,
            exists (
              select 1 from core.app_access aa
               where aa.user_id = p.id and aa.app = 'portal' and aa.status = 'active'
            ) as has_portal_access,
            m.tenant_id, m.role,
            (t.status = 'suspended') as tenant_suspended
       from core.profiles p
       left join core.memberships m
         on m.user_id = p.id and m.status = 'active'
       left join core.tenants t on t.id = m.tenant_id
      where p.id = $1`,
    [userId],
  );
  return {
    roles: Object.fromEntries(
      rows.filter((r) => r.tenant_id && r.role).map((r) => [r.tenant_id!, r.role!]),
    ),
    suspendedTenants: new Set(
      rows.filter((r) => r.tenant_id && r.tenant_suspended).map((r) => r.tenant_id!),
    ),
    isAdmin: rows[0]?.is_platform_admin === true,
    hasPortalAccess: rows[0]?.has_portal_access === true,
  };
}

function isRoleName(r: string): r is RoleName {
  return r in ROLE_RANK;
}

/**
 * Resolves the active tenant for the request and enforces a minimum role.
 *
 * Tenant selection: `x-tenant-id` header or `tenant_id` query param; if the
 * user has exactly one membership, that's used implicitly. Platform admins may
 * target any tenant (treated as super_admin). Attaches `req.tenant`.
 */
export function requireTenantRole(min: RoleName): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (!req.auth) throw new UnauthorizedError();

    const { roles, isAdmin, suspendedTenants, hasPortalAccess } = await resolveRoles(
      req.auth.user.id,
    );

    // The two revocations that sign-in already refuses, enforced again here.
    // Sign-in alone is not enough: an access token minted a moment before the
    // revoke stays cryptographically valid for its full ~15 minutes, and
    // `/auth/refresh` is the only other place that would notice. Checking on
    // every tenant-scoped request is what makes "revoke" mean now rather than
    // "within a quarter of an hour" — the same reasoning that already moved
    // role resolution off the frozen token claim and into this query.
    //
    // Platform admins are exempt from both, exactly as at sign-in: Aidapt
    // staff administer suspended clients, so the gate must never close on the
    // screens that lift it.
    if (!isAdmin && !hasPortalAccess) {
      // Same codes the sign-in gate uses, so the client can treat "your access
      // ended mid-session" identically wherever it surfaces.
      throw new AppError(
        'Your access to the Portal has been removed',
        403,
        'PORTAL_ACCESS_REVOKED',
      );
    }

    const requested =
      req.header('x-tenant-id') ?? (typeof req.query.tenant_id === 'string' ? req.query.tenant_id : null);

    let tenantId = requested;
    if (!tenantId) {
      const owned = Object.keys(roles);
      if (owned.length === 1) tenantId = owned[0]!;
      else if (owned.length === 0 && !isAdmin) throw new ForbiddenError('No tenant membership');
      else throw new BadRequestError('Specify tenant_id (multiple memberships)');
    }

    let role = roles[tenantId];
    if (!role) {
      if (isAdmin) role = 'super_admin';
      else throw new ForbiddenError('Not a member of this tenant');
    }
    // An unrecognised role now means the MEMBERSHIP row carries a role this app
    // doesn't rank (`core.role` also holds `client_facing_lead` and `team_member`,
    // which are other apps' vocabulary), not that the caller's session is old.
    // This used to answer 401 "refresh required", which was the right call while
    // roles came from a frozen JWT claim and a refresh re-stamped them; now that
    // `resolveRoles` reads core.memberships directly, refreshing changes nothing
    // and a 401 would just bounce the user out of a session that is perfectly
    // valid. 403 is the truthful answer: signed in, not entitled here.
    if (!isRoleName(role)) {
      throw new ForbiddenError('This role has no Portal access');
    }
    if (!meetsRole(role, min)) {
      throw new ForbiddenError(`Requires role ${min}`);
    }

    // Checked after the membership resolution above, so a stranger guessing a
    // suspended tenant's id still gets 'Not a member of this tenant' and
    // learns nothing about that client's standing.
    if (!isAdmin && suspendedTenants.has(tenantId)) {
      throw new AppError(
        'This organisation’s access is currently suspended',
        403,
        'TENANT_SUSPENDED',
      );
    }

    req.tenant = { id: tenantId, role };
    next();
  });
}
