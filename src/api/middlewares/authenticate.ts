import type { RequestHandler } from 'express';
import { UnauthorizedError } from '@common/errors/index.js';
import { supabaseAdmin, createUserScopedClient } from '@infra/supabase/client.js';
import { asyncHandler } from '@common/utils/async-handler.js';

/**
 * Verifies the Supabase JWT from the Authorization header and attaches the
 * authenticated user plus a request-scoped (RLS-aware) client to the request.
 */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = header.slice('Bearer '.length);
  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new UnauthorizedError('Invalid or expired token');
  }

  req.auth = {
    user: data.user,
    token,
    db: createUserScopedClient(token),
  };

  next();
});
