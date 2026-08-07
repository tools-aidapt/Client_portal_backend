import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { adminTenantsRepo } from '../repositories/tenants.repository.js';

export const adminTenantsController = {
  async list(_req: Request, res: Response): Promise<void> {
    const tenants = await adminTenantsRepo.list();
    res.status(StatusCodes.OK).json(ok({ tenants }));
  },
};
