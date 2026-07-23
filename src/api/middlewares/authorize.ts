import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '@common/errors/index.js';
import { asyncHandler } from '@common/utils/async-handler.js';
import { pool } from '@infra/db/pool.js';
import { config } from '@config/index.js';

/**
 * Requires the caller to be an Aidapt platform admin (super_admin).
 *
 * Fast path: the `platform_admin` claim stamped by the custom access token
 * hook. Fallback: a direct `core.profiles` lookup, so admin endpoints work
 * even before the hook is enabled in the dashboard.
 */
export const requirePlatformAdmin: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (!req.auth) throw new UnauthorizedError();

  const claim = (req.auth.user.app_metadata as { platform_admin?: boolean } | undefined)
    ?.platform_admin;

  if (claim === true) return next();

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
