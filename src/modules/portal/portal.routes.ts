import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { validate } from '@/api/middlewares/validate.js';
import { portalController } from './portal.controller.js';

/**
 * Client-facing Portal endpoints (design §10.4). Tenant-scoped and role-gated
 * per the capability matrix (§2.5). Every route authenticates, then resolves
 * the active tenant + minimum role.
 */
export const portalRoutes = Router();

portalRoutes.use(authenticate);

const plus = requireTenantRole('member_plus');
const member = requireTenantRole('member');

portalRoutes.get('/dashboard', plus, asyncHandler(portalController.dashboard));
portalRoutes.get('/projects', plus, asyncHandler(portalController.projects));
portalRoutes.get('/sprint/active', plus, asyncHandler(portalController.sprintActive));
portalRoutes.get('/onboarding', plus, asyncHandler(portalController.onboarding));
portalRoutes.get('/pod', member, asyncHandler(portalController.pod));
portalRoutes.get('/notifications', member, asyncHandler(portalController.notifications));
portalRoutes.post(
  '/notifications/:id/read',
  member,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(portalController.readNotification),
);
