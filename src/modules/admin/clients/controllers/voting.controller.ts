import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { votingService } from '@modules/wishlist/voting.service.js';
import { adminVotingRepo } from '../repositories/voting.repository.js';

/**
 * Admin control over a client's wishlist voting cycles.
 *
 * Every handler is scoped to the tenant in `:id`. That matters: the internal
 * month-end endpoint closes due cycles for EVERY tenant, so it can't be used to
 * act on one client without collateral.
 */
export const adminVotingController = {
  /** Cycles for this client, with the tally each produced. */
  async listCycles(req: Request, res: Response): Promise<void> {
    const cycles = await adminVotingRepo.cycles(req.params.id!);
    res.status(StatusCodes.OK).json(ok({ cycles }));
  },

  /** Per-item vote breakdown for one cycle. */
  async cycleBreakdown(req: Request, res: Response): Promise<void> {
    const items = await adminVotingRepo.cycleBreakdown(req.params.id!, req.params.cycleId!);
    res.status(StatusCodes.OK).json(ok({ items }));
  },

  /**
   * Close this cycle now: pick the winner, prioritise it, open the next one.
   *
   * `notify: false` does all of that silently. That is the intended path for a
   * cycle that expired with no votes — "No votes were cast this cycle" is a poor
   * first wishlist notification for a client to receive.
   */
  async closeCycle(req: Request, res: Response): Promise<void> {
    await adminVotingRepo.assertCycleBelongsTo(req.params.id!, req.params.cycleId!);
    const { notify } = req.body as { notify: boolean };
    const result = await votingService.closeCycle(req.params.cycleId!, { notify });
    res.status(StatusCodes.OK).json(ok(result));
  },

  /** Push an open cycle's close date out. */
  async extendCycle(req: Request, res: Response): Promise<void> {
    const { closes_at } = req.body as { closes_at: string };
    const cycle = await adminVotingRepo.extend(req.params.id!, req.params.cycleId!, closes_at);
    res.status(StatusCodes.OK).json(ok(cycle));
  },

  /** Open a fresh cycle for a client that has none. */
  async openCycle(req: Request, res: Response): Promise<void> {
    const cycle = await adminVotingRepo.open(req.params.id!, req.body as Record<string, string>);
    res.status(StatusCodes.CREATED).json(ok(cycle));
  },

  /** Reopen a closed cycle for more voting, clearing its recorded winner. */
  async reopenCycle(req: Request, res: Response): Promise<void> {
    const { closes_at } = req.body as { closes_at: string };
    const cycle = await adminVotingRepo.reopen(req.params.id!, req.params.cycleId!, closes_at);
    res.status(StatusCodes.OK).json(ok(cycle));
  },

  /** Move an item to in_progress / shipped (or back to candidate). */
  async setItemState(req: Request, res: Response): Promise<void> {
    const { state } = req.body as { state: string };
    const item = await adminVotingRepo.setItemState(req.params.id!, req.params.itemId!, state);
    res.status(StatusCodes.OK).json(ok(item));
  },
};
