import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { membersRepo } from '@modules/admin/clients/repositories/members.repository.js';

export const teamController = {
  /**
   * Who is in the caller's OWN tenant.
   *
   * Reuses `membersRepo.list` rather than restating the query: the rows are
   * identical, the only difference is where the tenant id comes from. Here it
   * is `req.tenant.id`, resolved by `requireTenantRole` from the caller's own
   * membership — never a path param — so an org admin cannot read another
   * client's team by guessing an id, which is exactly what separates this from
   * the platform-admin endpoint it shares a repository with.
   */
  async list(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    const members = await membersRepo.list(req.tenant.id);
    res.status(StatusCodes.OK).json(ok({ members }));
  },
};
