import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { wishlistService } from './wishlist.service.js';

function ctx(req: Request): { tenantId: string; userId: string } {
  if (!req.auth || !req.tenant) throw new UnauthorizedError();
  return { tenantId: req.tenant.id, userId: req.auth.user.id };
}

export const wishlistController = {
  async list(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = ctx(req);
    res.status(StatusCodes.OK).json(ok(await wishlistService.list(tenantId, userId)));
  },

  async submit(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = ctx(req);
    const { title, description } = req.body as { title: string; description?: string };
    const item = await wishlistService.submit(tenantId, userId, title, description);
    res.status(StatusCodes.CREATED).json(ok(item));
  },

  async vote(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = ctx(req);
    const result = await wishlistService.vote(tenantId, req.params.id!, userId);
    res.status(StatusCodes.OK).json(ok(result));
  },
};
