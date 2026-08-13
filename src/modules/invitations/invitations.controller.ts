import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { invitationsService } from './invitations.service.js';

export const invitationsController = {
  /** Org admin (MemberPro) invites a teammate into their own tenant. */
  async inviteToMyOrg(req: Request, res: Response): Promise<void> {
    if (!req.auth || !req.tenant) throw new UnauthorizedError();
    const { email, role, apps } = req.body as { email: string; role: string; apps?: string[] };
    const result = await invitationsService.invite({
      tenantId: req.tenant.id,
      email,
      role,
      invitedBy: req.auth.user.id,
      apps,
    });
    res.status(StatusCodes.CREATED).json(ok({ ...result, email, role, tenantId: req.tenant.id }));
  },
};
