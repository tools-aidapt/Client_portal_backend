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
 * Client-facing wishlist (design §10.4). MemberPlus+ can view, submit, and vote.
 */
export const wishlistRoutes = Router();

wishlistRoutes.use(authenticate, requireTenantRole('member_plus'));

wishlistRoutes.get('/', asyncHandler(wishlistController.list));

wishlistRoutes.post(
  '/',
  validate({
    body: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(wishlistController.submit),
);

wishlistRoutes.post(
  '/:id/vote',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(wishlistController.vote),
);

/**
 * Internal month-end voting close (design §10.6). Service-secret only; hit on a
 * monthly schedule (cron / n8n).
 */
export const votingRoutes = Router();

votingRoutes.post(
  '/close-cycle',
  requireServiceSecret,
  asyncHandler(async (_req, res) => {
    res.status(StatusCodes.OK).json(ok(await votingService.closeDueCycles()));
  }),
);
