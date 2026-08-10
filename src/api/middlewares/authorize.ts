import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '@common/errors/index.js';
import { asyncHandler } from '@common/utils/async-handler.js';
import { pool } from '@infra/db/pool.js';
import { config } from '@config/index.js';

/**
 * Requires the caller to be an Aidapt platform admin (super_admin).
 *
 * Read from `core.profiles` on every call, never from the token's
 * `platform_admin` claim: the claim is frozen at sign-in, so trusting it kept
 * staff privileges alive for the token's remaining lifetime after the flag was
 * revoked. Same reasoning as `resolveRoles` in tenant.ts, and it matters more
 * here — this is the highest-privilege gate in the app.
 */
export const requirePlatformAdmin: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (!req.auth) throw new UnauthorizedError();

  const { rows } = await pool.query<{ is_platform_admin: boolean }>(
    'select is_platform_admin from core.profiles where id = $1',
    [req.auth.user.id],
  );

  if (rows[0]?.is_platform_admin) return next();
  throw new ForbiddenError('Platform admin access required');
});

/**
 * Guards internal/service endpoints (outbox drain, sync, webhooks) with a shared
 * secret. These are called by cron / n8n / webhooks, never by the browser.
 */
export const requireServiceSecret: RequestHandler = (req, _res, next) => {
  const secret = config.internal.apiSecret;
  if (!secret) {
    throw new UnauthorizedError('Service endpoints are disabled (INTERNAL_API_SECRET unset)');
  }
  const provided = req.header('x-internal-secret');
  if (!provided || provided !== secret) {
    throw new UnauthorizedError('Invalid service secret');
  }
  next();
};
