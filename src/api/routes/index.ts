import { Router } from 'express';
import { authRoutes, invitationRoutes } from '@modules/auth/routes/auth.routes.js';
import { adminClientsRoutes } from '@modules/admin/clients/routes/clients.routes.js';
import { outboxRoutes } from '@modules/outbox/outbox.routes.js';
import { syncRoutes, clickupWebhookRoutes } from '@modules/sync/clickup/sync.routes.js';
import { portalRoutes } from '@modules/portal/portal.routes.js';
import { wishlistRoutes, votingRoutes } from '@modules/wishlist/wishlist.routes.js';
import { reportsRoutes } from '@modules/reports/reports.routes.js';

/**
 * Root API router. Every feature module mounts its routes here.
 * Versioning is handled by the API prefix (e.g. /api/v1) at the app level.
 */
export const apiRouter = Router();

// Auth / session (design §10.1)
apiRouter.use('/auth', authRoutes);

// Invitation acceptance — first-user activation (design §9.3 / §10.3)
apiRouter.use('/invitations', invitationRoutes);

// Client-facing Portal reads (design §10.4)
apiRouter.use('/', portalRoutes);
apiRouter.use('/wishlist', wishlistRoutes);
apiRouter.use('/reports', reportsRoutes);

// Admin — client lifecycle & onboarding (design §10.2)
apiRouter.use('/admin/clients', adminClientsRoutes);

// Internal — service-role only (design §10.6)
apiRouter.use('/internal/outbox', outboxRoutes);
apiRouter.use('/internal/sync', syncRoutes);
apiRouter.use('/internal/voting', votingRoutes);

// Webhooks — signature-verified, service-role (design §10.6)
apiRouter.use('/webhooks/clickup', clickupWebhookRoutes);
