import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { ok } from '@common/utils/api-response.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { requireServiceSecret } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { wishlistController } from './wishlist.controller.js';
import { votingService } from './voting.service.js';

/**
 * Client-facing wishlist (design §10.4).
 *
 * READ is `member`; submitting and voting stay `member_plus`. The gate used to be
 * router-wide at `member_plus`, which broke plain members badly: `/wishlist` is a
 * member's default landing page on the frontend, so signing in put them on a page
 * that answered 403 and rendered the raw string "Requires role member_plus" as
 * their whole screen. The spec's intent is a read-only board for members — they
 * can see what their team is prioritising, they just can't vote on it.
 */
export const wishlistRoutes = Router();

wishlistRoutes.use(authenticate);

const canRead = requireTenantRole('member');
const canVote = requireTenantRole('member_plus');

wishlistRoutes.get(
  '/',
  canRead,
  validate({
    query: z.object({
      state: z.enum(['candidate', 'prioritised', 'in_progress', 'shipped']).optional(),
    }),
  }),
  asyncHandler(wishlistController.list),
);

wishlistRoutes.post(
  '/',
  canVote,
  validate({
    body: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional(),
      reference_video_url: z.string().trim().url().max(2000).optional(),
      department: z.string().trim().max(100).optional(),
    }),
  }),
  asyncHandler(wishlistController.submit),
);

wishlistRoutes.post(
  '/:id/vote',
  canVote,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(wishlistController.vote),
);

// Un-vote. DELETE rather than POST /unvote because "remove my vote on this item"
// is exactly what it means; it is idempotent, so a retried request is safe.
wishlistRoutes.delete(
  '/:id/vote',
  canVote,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(wishlistController.unvote),
);

/**
 * Internal voting close (design §10.6). Service-secret only.
 *
 * Put this on a DAILY n8n schedule (`0 1 * * *`), not a monthly one. It is
 * idempotent and only touches cycles whose `closes_at` has passed, so on 29 days
 * in 30 it is a no-op HTTP call — whereas a monthly job that fails once silently
 * loses a whole month, which is exactly how Kenafric's cycle ended up overdue.
 *
 * It is GLOBAL: it closes due cycles for every tenant. Use the tenant-scoped
 * admin route to act on one client.
 */
export const votingRoutes = Router();

votingRoutes.post(
  '/close-cycle',
  requireServiceSecret,
  validate({ body: z.object({ notify: z.boolean().default(true) }) }),
  asyncHandler(async (req, res) => {
    const summary = await votingService.closeDueCycles({ notify: req.body.notify });
    res.status(StatusCodes.OK).json(ok(summary));
  }),
);
