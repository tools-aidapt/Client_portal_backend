import { createHash, randomBytes } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '@config/index.js';
import { UnauthorizedError } from '@common/errors/index.js';

/**
 * Claims carried by the access token. These mirror what the (never-enabled)
 * Supabase `custom_access_token_hook` would have stamped, so the existing
 * fast-path in `requirePlatformAdmin` / `requireTenantRole` keeps working.
 */
export interface AccessClaims {
  platform_admin: boolean;
  /** tenantId -> role, for active memberships. */
  tenant_roles: Record<string, string>;
}

export interface AccessTokenPayload extends AccessClaims {
  sub: string;
  email: string | null;
  typ: 'access';
}

/** Shape attached to `req.auth.user` after verification. */
export interface AuthUser {
  id: string;
  email: string | null;
  app_metadata: AccessClaims;
}

/** Signs a short-lived access token embedding identity + authz claims. */
export function signAccessToken(
  userId: string,
  email: string | null,
  claims: AccessClaims,
): string {
  const payload: Omit<AccessTokenPayload, 'sub'> = {
    email,
    typ: 'access',
    platform_admin: claims.platform_admin,
    tenant_roles: claims.tenant_roles,
  };
  return jwt.sign(payload, config.auth.accessSecret, {
    subject: userId,
    expiresIn: config.auth.accessTtl as SignOptions['expiresIn'],
  });
}

/** Verifies an access token and maps it to the request-scoped `AuthUser`. */
export function verifyAccessToken(token: string): AuthUser {
  let decoded: AccessTokenPayload;
  try {
    decoded = jwt.verify(token, config.auth.accessSecret) as AccessTokenPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
  if (decoded.typ !== 'access' || !decoded.sub) {
    throw new UnauthorizedError('Invalid token');
  }
  return {
    id: decoded.sub,
    email: decoded.email ?? null,
    app_metadata: {
      platform_admin: decoded.platform_admin === true,
      tenant_roles: decoded.tenant_roles ?? {},
    },
  };
}

/**
 * A fresh opaque refresh token plus its storable hash. Only the hash is
 * persisted; the raw value is returned to the client once and never stored.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** SHA-256 of a refresh token — used for both storage and lookup. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Converts a `ms`-style duration ("15m", "30d", "3600s") to milliseconds. */
export function durationToMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const factor: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * factor[unit]!;
}
