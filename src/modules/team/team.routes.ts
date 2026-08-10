import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { teamController } from './team.controller.js';

/**
 * A client managing its own people, as opposed to Aidapt managing a client's
 * people (`/admin/clients/:id/members`).
 *
 * Read-only on purpose. Inviting happens through `POST /invitations`, which is
 * gated the same way; changing someone's role or suspending them stays with
 * Aidapt, so a client admin cannot lock out a colleague — or promote one — on
 * their own.
 */
export const teamRoutes = Router();

teamRoutes.use(authenticate, requireTenantRole('admin'));

teamRoutes.get('/', asyncHandler(teamController.list));
