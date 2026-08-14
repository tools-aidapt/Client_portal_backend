import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError, NotFoundError, UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { membersRepo } from '@modules/admin/clients/repositories/members.repository.js';
import { invitationsRepo } from '@modules/admin/clients/repositories/invitations.repository.js';

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

  /**
   * Change which apps one of the caller's OWN colleagues may open.
   *
   * Deliberately narrower than the role/status controls, which stay with
   * Aidapt: granting a teammate the LMS or the Support Desk is routine account
   * administration an org admin should not have to raise a ticket for, whereas
   * promoting someone or suspending them changes who can administer the org.
   *
   * The tenant comes from `req.tenant.id` — the caller's own membership,
   * resolved by requireTenantRole — never from the request, so this cannot
   * reach another client's people.
   */
  async setApps(req: Request, res: Response): Promise<void> {
    if (!req.tenant || !req.auth) throw new UnauthorizedError();
    const { apps } = req.body as { apps: string[] };
    const member = await membersRepo.setAppAccess(
      req.tenant.id,
      req.params.userId!,
      apps,
      req.auth.user.id,
    );
    if (!member) throw new NotFoundError('That person is not a member of your organisation');
    res.status(StatusCodes.OK).json(ok(member));
  },

  /**
   * Invitations this org has sent, and what became of each.
   *
   * Nothing surfaced these before, so an org admin could send an invitation
   * and then had no way to see whether it had been accepted, or to stop it.
   * Tenant comes from `req.tenant.id` — the caller's own membership — so this
   * cannot read another client's invitations.
   */
  async listInvitations(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    const invitations = await invitationsRepo.list(req.tenant.id);
    res.status(StatusCodes.OK).json(ok({ invitations }));
  },

  /**
   * Withdraw an invitation this org sent.
   *
   * The distinction between 404 and 409 is deliberate: an id that belongs to
   * another tenant (or to nothing) must be indistinguishable from a typo, and
   * must NOT reveal that it exists elsewhere; whereas an invitation of this
   * org's that simply cannot be revoked — already accepted, already revoked —
   * deserves a specific reason so the admin knows the state rather than
   * assuming the button is broken.
   */
  async revokeInvitation(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    const tenantId = req.tenant.id;
    const id = req.params.invitationId!;

    const revoked = await invitationsRepo.revoke(tenantId, id);
    if (revoked) {
      res.status(StatusCodes.OK).json(ok(revoked));
      return;
    }

    const current = await invitationsRepo.statusOf(tenantId, id);
    if (!current) throw new NotFoundError('Invitation not found');
    if (current === 'accepted') {
      throw new AppError(
        'That invitation has already been accepted — remove their access from the team list instead',
        409,
        'INVITATION_ALREADY_ACCEPTED',
      );
    }
    throw new AppError(
      `That invitation is already ${current}`,
      409,
      'INVITATION_NOT_PENDING',
    );
  },
};
