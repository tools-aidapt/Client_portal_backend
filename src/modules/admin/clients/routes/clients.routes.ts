import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { z } from 'zod';
import { clientsController } from '../controllers/clients.controller.js';
import { membersController } from '../controllers/members.controller.js';
import { projectsController } from '../controllers/projects.controller.js';
import { taskLinksController } from '../controllers/task-links.controller.js';
import { adminVotingController } from '../controllers/voting.controller.js';
import {
  memberParams,
  registerClientBody,
  tenantIdParam,
  updateMemberBody,
} from '../validators/clients.validators.js';

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
      role: z.enum(['member', 'admin', 'super_admin']).default('member'),
    }),
  }),
  asyncHandler(clientsController.inviteUser),
);

// --- Members (who already has access to this client's Portal) ---
// The read side of invitations: `/:id/invitations` adds a person, these two
// show and adjust the people who already accepted.

adminClientsRoutes.get(
  '/:id/members',
  validate({ params: tenantIdParam }),
  asyncHandler(membersController.list),
);

// Role here is tenant-scoped only — `super_admin` is rejected by name, since
// granting platform-wide access is not something a per-client screen can do.
adminClientsRoutes.patch(
  '/:id/members/:userId',
  validate({ params: memberParams, body: updateMemberBody }),
  asyncHandler(membersController.update),
);

adminClientsRoutes.put(
  '/:id/clickup-mapping',
  validate({
    params: tenantIdParam,
    body: z
      .object({
        clickup_folder_id: z.string().min(1).optional(),
        clickup_client_group: z.string().min(1).optional(),
        // The client's "Monthly Progress Reports" folder — a SIBLING of the
        // client folder, so it is a separate id, never the same one.
        clickup_reports_folder_id: z.string().min(1).optional(),
      })
      .refine((b) => Object.keys(b).length > 0, {
        message: 'Provide a folder id, reports folder id, or client group',
      }),
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

// --- Wishlist → onboarding origin (which wishlist item a task came from) ---

adminClientsRoutes.get(
  '/:id/wishlist-items',
  validate({ params: tenantIdParam }),
  asyncHandler(taskLinksController.listWishlistItems),
);

// Keyed by ClickUp task id, not the internal task_cache uuid: the admin doing
// this has just created the task in ClickUp and has that id in front of them.
// `wishlist_item_id: null` unlinks — the same route corrects a mistake.
adminClientsRoutes.patch(
  '/:id/tasks/:taskId/wishlist-source',
  validate({
    params: tenantIdParam.extend({ taskId: z.string().trim().min(1).max(64) }),
    body: z.object({ wishlist_item_id: z.string().uuid().nullable() }),
  }),
  asyncHandler(taskLinksController.setWishlistSource),
);

// --- Voting cycles (tenant-scoped; /internal/voting/close-cycle is global) ---

const cycleParams = tenantIdParam.extend({ cycleId: z.string().uuid() });
const closesAtBody = z.object({ closes_at: z.string().datetime() });

adminClientsRoutes.get(
  '/:id/voting/cycles',
  validate({ params: tenantIdParam }),
  asyncHandler(adminVotingController.listCycles),
);

adminClientsRoutes.get(
  '/:id/voting/cycles/:cycleId/breakdown',
  validate({ params: cycleParams }),
  asyncHandler(adminVotingController.cycleBreakdown),
);

// `notify` defaults TRUE so closing a real cycle tells the client by default;
// pass false for a dead cycle nobody voted in.
adminClientsRoutes.post(
  '/:id/voting/cycles/:cycleId/close',
  validate({ params: cycleParams, body: z.object({ notify: z.boolean().default(true) }) }),
  asyncHandler(adminVotingController.closeCycle),
);

adminClientsRoutes.patch(
  '/:id/voting/cycles/:cycleId',
  validate({ params: cycleParams, body: closesAtBody }),
  asyncHandler(adminVotingController.extendCycle),
);

adminClientsRoutes.post(
  '/:id/voting/cycles/:cycleId/reopen',
  validate({ params: cycleParams, body: closesAtBody }),
  asyncHandler(adminVotingController.reopenCycle),
);

adminClientsRoutes.post(
  '/:id/voting/cycles',
  validate({
    params: tenantIdParam,
    body: z.object({
      // First of the month; defaults to the current month.
      period_month: z.string().date().optional(),
      closes_at: z.string().datetime().optional(),
    }),
  }),
  asyncHandler(adminVotingController.openCycle),
);

// The only path to in_progress / shipped — the close job only sets 'prioritised'.
adminClientsRoutes.patch(
  '/:id/wishlist-items/:itemId',
  validate({
    params: tenantIdParam.extend({ itemId: z.string().uuid() }),
    body: z.object({ state: z.enum(['candidate', 'prioritised', 'in_progress', 'shipped']) }),
  }),
  asyncHandler(adminVotingController.setItemState),
);
