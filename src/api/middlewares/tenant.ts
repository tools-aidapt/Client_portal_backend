import type { RequestHandler } from 'express';
import { BadRequestError, ForbiddenError, UnauthorizedError } from '@common/errors/index.js';
import { asyncHandler } from '@common/utils/async-handler.js';
import { pool } from '@infra/db/pool.js';
import { ROLE_RANK, meetsRole, type RoleName } from '@common/constants/roles.js';

interface Resolved {
  roles: Record<string, string>; // tenantId -> role
  isAdmin: boolean;
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
    tenant_id: string | null;
    role: string | null;
  }>(
    `select p.is_platform_admin, m.tenant_id, m.role
       from core.profiles p
       left join core.memberships m
         on m.user_id = p.id and m.status = 'active'
      where p.id = $1`,
    [userId],
  );
  return {
    roles: Object.fromEntries(
      rows.filter((r) => r.tenant_id && r.role).map((r) => [r.tenant_id!, r.role!]),
    ),
    isAdmin: rows[0]?.is_platform_admin === true,
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

    const { roles, isAdmin } = await resolveRoles(req.auth.user.id);
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

    req.tenant = { id: tenantId, role };
    next();
  });
}
