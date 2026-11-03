import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { validate } from '@/api/middlewares/validate.js';
import { useCasesController } from './usecases.controller.js';
import { MAX_LIMIT } from './usecases.service.js';

/**
 * GET /usecases       — the shared use case library (+ the client's live automations).
 * GET /usecases/:slug — one study with its full narrative, for the expanded card.
 *
 * Gated at member_plus, matching `/projects`: the live half is the same
 * delivery data that endpoint serves.
 */
export const useCasesRoutes = Router();

useCasesRoutes.use(authenticate);

const admin = requireTenantRole('admin');

/**
 * A comma-separated filter (`?niche=Fintech,Insurance`). Values within one
 * dimension are OR'd in the repository. Trimmed, empties dropped, and capped so
 * a request can't fan out into an unbounded `= ANY(...)` list.
 */
const MAX_FILTER_VALUES = 10;
const multiValue = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  )
  .pipe(z.array(z.string().max(80)).max(MAX_FILTER_VALUES))
  .optional();

/**
 * `q` is free text (sanitised into a tsquery in the service, never interpolated).
 * Length-capped so a huge string can't turn into a pathological tsquery.
 */
const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  niche: multiValue,
  category: multiValue,
  build_type: multiValue,
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

useCasesRoutes.get('/', admin, validate({ query: listQuery }), asyncHandler(useCasesController.list));
useCasesRoutes.get(
  '/:slug',
  admin,
  validate({ params: z.object({ slug: z.string().min(1).max(64) }) }),
  asyncHandler(useCasesController.detail),
);
