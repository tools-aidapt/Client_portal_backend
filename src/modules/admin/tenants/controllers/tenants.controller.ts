import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError, NotFoundError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { adminTenantsRepo } from '../repositories/tenants.repository.js';

export const adminTenantsController = {
  async list(_req: Request, res: Response): Promise<void> {
    const tenants = await adminTenantsRepo.list();
    res.status(StatusCodes.OK).json(ok({ tenants }));
  },

  /**
   * Switch a whole client off.
   *
   * `suspend` returns null for three different situations, so the reason is
   * worked out here rather than answering one flat 404 that would leave an
   * admin guessing whether they had the wrong id or clicked a button that
   * silently does nothing:
   *
   * - no such tenant → 404
   * - Aidapt's own client group → 409. Suspending it would revoke every member
   *   of staff's sessions and then refuse their sign-in, which includes the
   *   people who would lift the suspension. The database refuses it in the
   *   WHERE clause too, so a hand-rolled request cannot get past this either.
   * - already suspended → 409, and deliberately not a silent success: the
   *   admin's mental model is "this was off already", which is worth saying.
   */
  async suspend(req: Request, res: Response): Promise<void> {
    const tenantId = req.params.id!;
    const { reason } = req.body as { reason?: string };

    const { tenant, sessionsRevoked } = await adminTenantsRepo.suspend(
      tenantId,
      req.auth?.user.id ?? null,
      reason?.trim() || null,
    );

    if (!tenant) {
      const current = await adminTenantsRepo.byId(tenantId);
      if (!current) throw new NotFoundError('Client not found');
      if (current.is_protected) {
        throw new AppError(
          'The Aidapt client group cannot be suspended — doing so would lock every member of staff out of the screen needed to undo it',
          409,
          'TENANT_PROTECTED',
        );
      }
      throw new AppError('That client is already suspended', 409, 'TENANT_ALREADY_SUSPENDED');
    }

    res.status(StatusCodes.OK).json(ok({ tenant, sessions_revoked: sessionsRevoked }));
  },

  /**
   * Switch a client back on, restoring the lifecycle status it held before.
   *
   * 409 rather than a no-op on a tenant that was never suspended, for the same
   * reason as above — and because a silent success here would imply the tenant
   * had been switched off, which for an `offboarded` client would be actively
   * misleading.
   */
  async resume(req: Request, res: Response): Promise<void> {
    const tenantId = req.params.id!;
    const tenant = await adminTenantsRepo.resume(tenantId, req.auth?.user.id ?? null);

    if (!tenant) {
      const current = await adminTenantsRepo.byId(tenantId);
      if (!current) throw new NotFoundError('Client not found');
      throw new AppError('That client is not suspended', 409, 'TENANT_NOT_SUSPENDED');
    }

    res.status(StatusCodes.OK).json(ok({ tenant }));
  },
};
