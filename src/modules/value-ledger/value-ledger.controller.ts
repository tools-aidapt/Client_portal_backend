import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { UnauthorizedError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { valueLedgerService } from './value-ledger.service.js';

export const valueLedgerController = {
  /** Runs after `requireTenantRole`, so `req.tenant` is the resolved client. */
  async link(req: Request, res: Response): Promise<void> {
    if (!req.tenant) throw new UnauthorizedError();
    const link = await valueLedgerService.link(req.tenant.id);
    // A signed, short-lived link: never cache it anywhere.
    res.set('Cache-Control', 'no-store');
    res.status(StatusCodes.OK).json(ok(link));
  },
};
