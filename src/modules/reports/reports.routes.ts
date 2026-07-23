import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { requirePlatformAdmin } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { reportsController } from './reports.controller.js';

/**
 * Reports + Sprint Pulse (design §10.4). Reads/pulse are MemberPro; create and
 * publish are platform-admin. Gating is per-route (mixed audiences).
 */
export const reportsRoutes = Router();

reportsRoutes.use(authenticate);

const proOnly = requireTenantRole('member_pro');
const idParam = z.object({ id: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// --- Platform admin: create draft + publish ---
reportsRoutes.post(
  '/',
  requirePlatformAdmin,
  validate({
    body: z.object({
      tenant_id: z.string().uuid(),
      sprint_id: z.string().uuid().optional(),
      title: z.string().trim().min(1).max(300).optional(),
      period_start: isoDate.optional(),
      period_end: isoDate.optional(),
      summary_md: z.string().max(20000).optional(),
      committed_count: z.number().int().min(0).optional(),
      delivered_count: z.number().int().min(0).optional(),
    }),
  }),
  asyncHandler(reportsController.create),
);

reportsRoutes.post(
  '/:id/publish',
  requirePlatformAdmin,
  validate({ params: idParam }),
  asyncHandler(reportsController.publish),
);

// --- MemberPro: list, detail, pulse ---
reportsRoutes.get('/', proOnly, asyncHandler(reportsController.list));

reportsRoutes.get('/:id', proOnly, validate({ params: idParam }), asyncHandler(reportsController.get));

reportsRoutes.post(
  '/:id/pulse',
  proOnly,
  validate({
    params: idParam,
    body: z.object({
      score: z.number().int().min(1).max(5),
      comment: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(reportsController.pulse),
);
