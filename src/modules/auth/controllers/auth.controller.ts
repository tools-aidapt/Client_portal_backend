import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { authService } from '../services/auth.service.js';
import { uploadAvatar } from '../avatar.js';
import type {
  AcceptInvitationBody,
  LoginBody,
  LogoutBody,
  RefreshBody,
  RegisterBody,
  UpdateProfileBody,
} from '../validators/auth.validators.js';

export const authController = {
  async register(req: Request, res: Response): Promise<void> {
    const body = req.body as RegisterBody;
    const result = await authService.register(body, req.header('user-agent') ?? undefined);
    res.status(StatusCodes.CREATED).json(ok(result));
  },

  async login(req: Request, res: Response): Promise<void> {
    const body = req.body as LoginBody;
    const result = await authService.login(body, req.header('user-agent') ?? undefined);
    res.status(StatusCodes.OK).json(ok(result));
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const { refreshToken } = req.body as RefreshBody;
    const result = await authService.refresh(refreshToken, req.header('user-agent') ?? undefined);
    res.status(StatusCodes.OK).json(ok(result));
  },

  async logout(req: Request, res: Response): Promise<void> {
    const { refreshToken } = req.body as LogoutBody;
    const result = await authService.logout(refreshToken);
    res.status(StatusCodes.OK).json(ok(result));
  },

  async logoutAll(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    await authService.logoutAll(req.auth.user.id);
    res.status(StatusCodes.OK).json(ok({ revoked: true }));
  },

  async me(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const me = await authService.me(req.auth.user.id);
    if (!me) throw new NotFoundError('Profile not found');
    res.status(StatusCodes.OK).json(ok(me));
  },

  async updateMe(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    const me = await authService.updateProfile(req.auth.user.id, req.body as UpdateProfileBody);
    if (!me) throw new NotFoundError('Profile not found');
    res.status(StatusCodes.OK).json(ok(me));
  },

  async uploadAvatar(req: Request, res: Response): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();
    if (!req.file) throw new BadRequestError('No file uploaded (form field "file")');
    const url = await uploadAvatar(req.auth.user.id, req.file);
    res.status(StatusCodes.OK).json(ok({ avatar_url: url }));
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
