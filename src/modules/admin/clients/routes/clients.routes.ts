import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { z } from 'zod';
import { clientsController } from '../controllers/clients.controller.js';
import { projectsController } from '../controllers/projects.controller.js';
import { registerClientBody, tenantIdParam } from '../validators/clients.validators.js';

/**
 * Admin client-lifecycle endpoints (design §10.2). All require a platform admin.
 * Only the subset backed by the onboarding orchestration is wired for v1; the
 * remaining §10.2 routes will attach here as they are implemented.
 */
export const adminClientsRoutes = Router();

adminClientsRoutes.use(authenticate, requirePlatformAdmin);

adminClientsRoutes.post(
  '/',
  validate({ body: registerClientBody }),
  asyncHandler(clientsController.register),
);

adminClientsRoutes.get('/', asyncHandler(clientsController.list));

adminClientsRoutes.get(
  '/:id/onboarding',
  validate({ params: tenantIdParam }),
  asyncHandler(clientsController.getOnboarding),
);

adminClientsRoutes.post(
  '/:id/invitations',
  validate({
    params: tenantIdParam,
    body: z.object({
      email: z.string().trim().toLowerCase().email(),
      // Platform admin may grant any role, including super_admin (platform staff).
      role: z.enum(['member', 'member_plus', 'member_pro', 'org_admin', 'super_admin']).default('member'),
    }),
  }),
  asyncHandler(clientsController.inviteUser),
);

adminClientsRoutes.put(
  '/:id/clickup-mapping',
  validate({
    params: tenantIdParam,
    body: z
      .object({
        clickup_folder_id: z.string().min(1).optional(),
        clickup_client_group: z.string().min(1).optional(),
      })
      .refine((b) => Object.keys(b).length > 0, { message: 'Provide folder id or client group' }),
  }),
  asyncHandler(clientsController.setClickupMapping),
);

// --- Project visibility (which ClickUp lists show in the client's Portal) ---

adminClientsRoutes.get(
  '/:id/projects',
  validate({ params: tenantIdParam }),
  asyncHandler(projectsController.list),
);

adminClientsRoutes.post(
  '/:id/projects/discover',
  validate({ params: tenantIdParam }),
  asyncHandler(projectsController.discover),
);

adminClientsRoutes.patch(
  '/:id/projects/:listId',
  validate({
    params: tenantIdParam.extend({ listId: z.string().min(1) }),
    body: z.object({ is_visible: z.boolean() }),
  }),
  asyncHandler(projectsController.setVisibility),
);
