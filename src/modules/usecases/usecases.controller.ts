import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { useCasesService } from './usecases.service.js';

export const useCasesController = {
  /**
   * Runs after `requireTenantRole`. The library itself is tenant-agnostic, but
   * membership is still required — it's client-facing content, not public.
   */
  async list(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    // `limit` is coerced to a number by the route's zod schema.
    const { q, niche, category, build_type: buildType, limit } = req.query as unknown as {
      q?: string;
      niche?: string;
      category?: string;
      build_type?: string;
      limit?: number;
    };
    res
      .status(StatusCodes.OK)
      .json(ok(await useCasesService.list({ q, niche, category, buildType, limit })));
  },

  async detail(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    const useCase = await useCasesService.detail(req.params.slug!);
    if (!useCase) throw new NotFoundError('Use case not found');
    res.status(StatusCodes.OK).json(ok(useCase));
  },
};
