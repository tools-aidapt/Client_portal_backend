import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { validate } from '@/api/middlewares/validate.js';
import { teamController } from './team.controller.js';

/**
 * A client managing its own people, as opposed to Aidapt managing a client's
 * people (`/admin/clients/:id/members`).
 *
 * Mostly read-only. Inviting happens through `POST /invitations`, which is
 * gated the same way; changing someone's role or suspending them stays with
 * Aidapt, so a client admin cannot lock out a colleague — or promote one — on
 * their own.
 *
 * The one write here is app access: which of the three products a colleague
 * may open. That is routine account administration, and it cannot escalate
 * anyone's standing in the org.
 */
export const teamRoutes = Router();

teamRoutes.use(authenticate, requireTenantRole('admin'));

teamRoutes.get('/', asyncHandler(teamController.list));

// 'portal' is accepted but always implied — setAppAccess never revokes it.
teamRoutes.patch(
  '/:userId/apps',
  validate({
    params: z.object({ userId: z.string().uuid() }),
    body: z.object({
      apps: z.array(z.enum(['portal', 'lms', 'support_desk'])).max(3),
    }),
  }),
  asyncHandler(teamController.setApps),
);
