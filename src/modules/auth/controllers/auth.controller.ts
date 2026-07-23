import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { authService } from '../services/auth.service.js';
import type { AcceptInvitationBody } from '../validators/auth.validators.js';

export const authController = {
  async me(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const me = await authService.me(req.auth.user.id);
    if (!me) throw new NotFoundError('Profile not found');
    res.status(StatusCodes.OK).json(ok(me));
  },

  async acceptInvitation(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const email = req.auth.user.email;
    if (!email) throw new UnauthorizedError('Authenticated user has no email');

    const { token } = req.body as AcceptInvitationBody;
    const result = await authService.acceptInvitation(req.auth.user.id, email, token);
    res.status(StatusCodes.OK).json(ok(result));
  },
};
