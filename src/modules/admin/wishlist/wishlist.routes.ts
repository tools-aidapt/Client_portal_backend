import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { adminWishlistController } from './wishlist.controller.js';
import { createWishlistItemBody } from './wishlist.validators.js';

/**
 * Super-admin-only wishlist authoring. Distinct from `@modules/wishlist`
 * (client-facing reads/votes) — this posts a new item into the same intake
 * pipeline the public form uses, on a client's behalf.
 */
export const adminWishlistRoutes = Router();

adminWishlistRoutes.use(authenticate, requirePlatformAdmin);

adminWishlistRoutes.get('/client-groups', asyncHandler(adminWishlistController.listClientGroups));

adminWishlistRoutes.post(
  '/',
  validate({ body: createWishlistItemBody }),
  asyncHandler(adminWishlistController.create),
);
