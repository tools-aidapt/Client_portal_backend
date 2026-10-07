import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { valueLedgerController } from './value-ledger.controller.js';

/**
 * GET /value-ledger/link — a short-lived signed URL for the tenant's Value
 * Ledger embed, or `{ configured: false }` when it isn't set up yet.
 *
 * `member`, the lowest client role: every client user sees their own ledger.
 * The tenant comes from `requireTenantRole`; there is no client-key parameter.
 */
export const valueLedgerRoutes = Router();

valueLedgerRoutes.use(authenticate);

valueLedgerRoutes.get('/link', requireTenantRole('member'), asyncHandler(valueLedgerController.link));
