import type { RequestHandler } from 'express';
import { UnauthorizedError } from '@common/errors/index.js';
import { asyncHandler } from '@common/utils/async-handler.js';
import { verifyAccessToken } from '@modules/auth/utils/tokens.js';

/**
 * Verifies the self-hosted access token (JWT) from the Authorization header and
 * attaches the authenticated user to the request. The token's `app_metadata`
 * carries the `platform_admin` / `tenant_roles` claims consumed by the
 * authorization middlewares.
 */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = header.slice('Bearer '.length);
  const user = verifyAccessToken(token);

  req.auth = { user, token };

  next();
});
