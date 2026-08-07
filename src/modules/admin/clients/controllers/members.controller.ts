import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { membersRepo } from '../repositories/members.repository.js';
import type { UpdateMemberBody } from '../validators/clients.validators.js';

/**
 * Aidapt staff managing who has access to one client's Portal.
 *
 * The third leg of member management, alongside
 * `POST /admin/clients/:id/invitations` (which adds someone) — this is the
 * "who is already here, and what can they do" half that had no endpoint at all
 * before, so the only way to see or change a client's members was direct SQL.
 */
export const membersController = {
  async list(req: Request, res: Response): Promise<void> {
    const members = await membersRepo.list(req.params.id!);
    res.status(StatusCodes.OK).json(ok({ members }));
  },

  async update(req: Request, res: Response): Promise<void> {
    const body = req.body as UpdateMemberBody;
    const member = await membersRepo.update(req.params.id!, req.params.userId!, body);
    if (!member) throw new NotFoundError('That person is not a member of this client');
    res.status(StatusCodes.OK).json(ok(member));
  },
};
