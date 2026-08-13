import { Router } from 'express';
import { authRoutes, invitationRoutes } from '@modules/auth/routes/auth.routes.js';
import { adminClientsRoutes } from '@modules/admin/clients/routes/clients.routes.js';
import { adminTenantsRoutes } from '@modules/admin/tenants/routes/tenants.routes.js';
import { adminWishlistRoutes } from '@modules/admin/wishlist/wishlist.routes.js';
import { syncConsoleRoutes } from '@modules/admin/sync/sync-console.routes.js';
import { outboxRoutes } from '@modules/outbox/outbox.routes.js';
import { syncRoutes, clickupWebhookRoutes } from '@modules/sync/clickup/sync.routes.js';
import { portalRoutes } from '@modules/portal/portal.routes.js';
import { wishlistRoutes, votingRoutes } from '@modules/wishlist/wishlist.routes.js';
import { reportsRoutes } from '@modules/reports/reports.routes.js';
import { useCasesRoutes } from '@modules/usecases/usecases.routes.js';
import { teamRoutes } from '@modules/team/team.routes.js';
import {
  adminAutomationRoutes,
  automationHealthRoutes,
  n8nWebhookRoutes,
} from '@modules/automation/automation.routes.js';

/**
 * Root API router. Every feature module mounts its routes here.
 * Versioning is handled by the API prefix (e.g. /api/v1) at the app level.
 */
export const apiRouter = Router();

// Auth / session (design §10.1)
apiRouter.use('/auth', authRoutes);

// Invitation acceptance — first-user activation (design §9.3 / §10.3)
apiRouter.use('/invitations', invitationRoutes);

// Client-facing Portal (design §10.4)
apiRouter.use('/wishlist', wishlistRoutes);
apiRouter.use('/reports', reportsRoutes);
apiRouter.use('/automations', automationHealthRoutes);
apiRouter.use('/usecases', useCasesRoutes);
// A client managing its own people (read-only; invites go via /invitations).
apiRouter.use('/team', teamRoutes);

// Admin — client lifecycle & onboarding (design §10.2)
apiRouter.use('/admin/clients', adminClientsRoutes);
// Tenant directory backing the Portal's admin tenant picker.
apiRouter.use('/admin/tenants', adminTenantsRoutes);
apiRouter.use('/admin/clients/:id/automations', adminAutomationRoutes);
apiRouter.use('/admin/wishlist', adminWishlistRoutes);
// Sync Console — platform-admin, browser-facing sibling of /internal/sync.
apiRouter.use('/admin/sync', syncConsoleRoutes);

// Internal — service-role only (design §10.6)
apiRouter.use('/internal/outbox', outboxRoutes);
apiRouter.use('/internal/sync', syncRoutes);
apiRouter.use('/internal/voting', votingRoutes);

// Webhooks — signature-verified, service-role (design §10.6)
apiRouter.use('/webhooks/clickup', clickupWebhookRoutes);
apiRouter.use('/webhooks/n8n', n8nWebhookRoutes);

// Portal reads are mounted at '/' with a router-level `authenticate`, so this
// MUST be last — otherwise its auth guard intercepts the service/webhook routes.
apiRouter.use('/', portalRoutes);
