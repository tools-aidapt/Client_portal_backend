import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { adminWishlistService } from './wishlist.service.js';
import { CLIENT_GROUPS, type CreateWishlistItemBody } from './wishlist.validators.js';

export const adminWishlistController = {
  async listClientGroups(_req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok({ client_groups: CLIENT_GROUPS }));
  },

  async create(req: Request, res: Response): Promise<void> {
    const body = req.body as CreateWishlistItemBody;
    await adminWishlistService.create(body);
    res.status(StatusCodes.ACCEPTED).json(ok({ submitted: true }));
  },
};
