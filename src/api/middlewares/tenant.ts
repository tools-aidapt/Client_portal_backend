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
 * Resolve the caller's tenant roles. Fast path: the JWT claims stamped by the
 * access token hook. Fallback: core.memberships / core.profiles (so this works
 * before the hook is enabled).
 */
async function resolveRoles(userId: string, appMeta: unknown): Promise<Resolved> {
  const claims = appMeta as { tenant_roles?: Record<string, string>; platform_admin?: boolean };
  if (claims?.tenant_roles) {
    return { roles: claims.tenant_roles, isAdmin: claims.platform_admin === true };
  }
  const [m, p] = await Promise.all([
    pool.query<{ tenant_id: string; role: string }>(
      `select tenant_id, role from core.memberships where user_id = $1 and status = 'active'`,
      [userId],
    ),
    pool.query<{ is_platform_admin: boolean }>(
      `select is_platform_admin from core.profiles where id = $1`,
      [userId],
    ),
  ]);
  return {
    roles: Object.fromEntries(m.rows.map((r) => [r.tenant_id, r.role])),
    isAdmin: p.rows[0]?.is_platform_admin === true,
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

    const { roles, isAdmin } = await resolveRoles(req.auth.user.id, req.auth.user.app_metadata);
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
    if (!isRoleName(role) || !meetsRole(role, min)) {
      throw new ForbiddenError(`Requires role ${min}`);
    }

    req.tenant = { id: tenantId, role };
    next();
  });
}
