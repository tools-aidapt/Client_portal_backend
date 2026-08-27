import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError, NotFoundError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { adminTenantsRepo } from '@modules/admin/tenants/repositories/tenants.repository.js';
import { membersRepo } from '../repositories/members.repository.js';
import { syncUserToLms, syncUserToSupportDesk } from '@modules/auth/cross-app.js';
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
    // Platform admins see suspended members too — they are the ones who
    // restore them. The client-facing Team view does not.
    const members = await membersRepo.list(req.params.id!, { includeSuspended: true });
    res.status(StatusCodes.OK).json(ok({ members }));
  },

  async update(req: Request, res: Response): Promise<void> {
    const body = req.body as UpdateMemberBody;
    const tenantId = req.params.id!;
    const userId = req.params.userId!;

    // Platform-wide staff access belongs to Aidapt's own people, so it can only
    // be granted from inside Aidapt's client group. Checked against
    // `core.tenants.is_protected` rather than the request, so no client screen
    // — and no hand-rolled PATCH at a client's tenant id — can mint one.
    if (body.role === 'super_admin' && !(await adminTenantsRepo.isInternal(tenantId))) {
      throw new AppError(
        'Super admin is Aidapt staff access — it can only be given to a member of the Aidapt client group',
        400,
        'SUPER_ADMIN_TENANT_ONLY',
      );
    }

    // Nobody demotes themselves: the same PATCH clears `is_platform_admin`, so
    // the click that removed the role would also remove the access needed to
    // put it back, from this screen and every other admin one.
    if (body.role && body.role !== 'super_admin' && userId === req.auth?.user.id) {
      throw new AppError(
        'You cannot change your own role — ask another Aidapt admin to do it',
        400,
        'CANNOT_CHANGE_OWN_ROLE',
      );
    }

    const member = await membersRepo.update(tenantId, userId, body);
    if (!member) throw new NotFoundError('That person is not a member of this client');

    // Push the new role to the sibling apps. Registration was previously the
    // ONLY thing that ever synced a role, so promoting someone here left them
    // stuck at whatever they were first invited as in LMS/Support Desk —
    // forever, and silently. Best-effort and non-blocking, exactly like the
    // registration-time sync: the Portal membership is authoritative whether
    // or not the other two are reachable.
    if (body.role && member.email) {
      const passwordHash = await membersRepo.passwordHash(member.user_id);
      if (passwordHash) {
        void syncUserToLms({
          userId: member.user_id,
          email: member.email,
          passwordHash,
          fullName: member.full_name,
          role: member.role,
        });
      }
      void syncUserToSupportDesk({
        email: member.email,
        fullName: member.full_name,
        role: member.role,
      });
    }

    res.status(StatusCodes.OK).json(ok(member));
  },

  /**
   * Aidapt setting which apps one client's person may open. Same operation the
   * org's own admin has via PATCH /team/:userId/apps, but reachable for any
   * tenant rather than only the caller's own.
   */
  async setApps(req: Request, res: Response): Promise<void> {
    const { apps } = req.body as { apps: string[] };
    const member = await membersRepo.setAppAccess(
      req.params.id!,
      req.params.userId!,
      apps,
      req.auth?.user.id ?? null,
    );
    if (!member) throw new NotFoundError('That person is not a member of this client');
    res.status(StatusCodes.OK).json(ok(member));
  },
};
