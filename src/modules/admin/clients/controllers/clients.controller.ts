import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { onboardingService } from '../services/onboarding.service.js';
import { onboardingRepo } from '../repositories/onboarding.repository.js';
import type { RegisterClientBody } from '../validators/clients.validators.js';

export const clientsController = {
  async register(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const body = req.body as RegisterClientBody;

    const result = await onboardingService.register(
      {
        name: body.name,
        emailDomains: body.email_domains,
        productTier: body.product_tier,
        clickupFolderId: body.clickup_folder_id,
        clickupClientGroup: body.clickup_client_group,
        adminEmail: body.admin_email,
        sigmaReady: body.sigma_ready,
      },
      req.auth.user.id,
    );

    res.status(StatusCodes.CREATED).json(ok(result));
  },

  async list(_req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await onboardingRepo.listTenants()));
  },

  async getOnboarding(req: Request, res: Response): Promise<void> {
    const detail = await onboardingRepo.getOnboarding(req.params.id!);
    if (!detail) throw new NotFoundError('No onboarding found for this tenant');
    res.status(StatusCodes.OK).json(ok(detail));
  },

  /** Set the tenant's ClickUp folder + Client Group so sync can route its tasks. */
  async setClickupMapping(req: Request, res: Response): Promise<void> {
    const body = req.body as { clickup_folder_id?: string; clickup_client_group?: string };
    const updated = await onboardingRepo.updateClickupMapping(req.params.id!, body);
    if (!updated) throw new NotFoundError('Tenant not found');
    res.status(StatusCodes.OK).json(ok(updated));
  },
};
