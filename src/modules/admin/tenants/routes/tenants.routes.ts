import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { adminTenantsController } from '../controllers/tenants.controller.js';

/**
 * Tenant directory for Aidapt staff. Backs the Portal's admin tenant picker:
 * the chosen id is sent back as `x-tenant-id`, which `requireTenantRole`
 * already honours for a platform admin on every client-facing portal route.
 *
 * Distinct from `GET /admin/clients`, which is the onboarding-lifecycle view
 * (product tier, onboarding state) rather than a picker list.
 */
export const adminTenantsRoutes = Router();

adminTenantsRoutes.use(authenticate, requirePlatformAdmin);

adminTenantsRoutes.get('/', asyncHandler(adminTenantsController.list));

/**
 * Switching a whole client off and back on. Aidapt staff only — this is the
 * one control on any screen that can stop an entire organisation working, and
 * `requirePlatformAdmin` above is what keeps it out of a client admin's reach.
 *
 * POST on a sub-path rather than `PATCH /:id { status }`, for the same reason
 * invitation revoke is a POST: these are two named operations with their own
 * side effects (remembering the previous status, killing live sessions,
 * writing an audit row), not a field being set. A generic status PATCH would
 * also let 'suspended' be written without any of that happening.
 */
const tenantParams = z.object({ id: z.string().uuid() });

adminTenantsRoutes.post(
  '/:id/suspend',
  validate({
    params: tenantParams,
    // Internal note for staff — never shown to the client, whose sign-in
    // refusal stays generic on purpose.
    body: z.object({ reason: z.string().trim().max(500).optional() }),
  }),
  asyncHandler(adminTenantsController.suspend),
);

adminTenantsRoutes.post(
  '/:id/resume',
  validate({ params: tenantParams }),
  asyncHandler(adminTenantsController.resume),
);
