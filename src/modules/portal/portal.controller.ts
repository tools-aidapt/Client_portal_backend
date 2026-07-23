import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { portalService } from './portal.service.js';

/** Every handler runs after `requireTenantRole`, so req.tenant + req.auth are set. */
function ctx(req: Request): { tenantId: string; userId: string } {
  if (!req.auth || !req.tenant) throw new UnauthorizedError();
  return { tenantId: req.tenant.id, userId: req.auth.user.id };
}

export const portalController = {
  async dashboard(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = ctx(req);
    res.status(StatusCodes.OK).json(ok(await portalService.dashboard(tenantId, userId)));
  },

  async projects(req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await portalService.projects(ctx(req).tenantId)));
  },

  async sprintActive(req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await portalService.sprintActive(ctx(req).tenantId)));
  },

  async onboarding(req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await portalService.onboarding(ctx(req).tenantId)));
  },

  async pod(req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await portalService.pod(ctx(req).tenantId)));
  },

  async notifications(req: Request, res: Response): Promise<void> {
    const { tenantId, userId } = ctx(req);
    res.status(StatusCodes.OK).json(ok(await portalService.notifications(userId, tenantId)));
  },

  async readNotification(req: Request, res: Response): Promise<void> {
    const { userId } = ctx(req);
    const done = await portalService.markNotificationRead(req.params.id!, userId);
    if (!done) throw new NotFoundError('Notification not found');
    res.status(StatusCodes.OK).json(ok({ id: req.params.id, is_read: true }));
  },
};
