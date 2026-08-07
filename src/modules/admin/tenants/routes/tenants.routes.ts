import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
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
