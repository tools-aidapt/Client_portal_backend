import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { taskStatusRepo } from '../repositories/task-status.repository.js';

/**
 * Manual status control for a client's cached tasks (phases and subtasks).
 * Hub-only: nothing here touches ClickUp.
 */
export const taskStatusController = {
  /** The status catalogue the picker offers. */
  async catalogue(_req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok({ statuses: await taskStatusRepo.catalogue() }));
  },

  /** Pin a whole project to a status, or clear the pin with `status_key: null`. */
  async setProjectStatus(req: Request, res: Response): Promise<void> {
    const userId = req.auth?.user.id;
    if (!userId) throw new AppError('No authenticated user', 401, 'UNAUTHENTICATED');
    const { status_key } = req.body as { status_key: string | null };
    const state = await taskStatusRepo.setProjectOverride(req.params.id!, req.params.listId!, status_key, userId);
    res.status(StatusCodes.OK).json(ok(state));
  },

  /** Pin a task to a status, or clear the pin with `status_key: null`. */
  async setStatus(req: Request, res: Response): Promise<void> {
    const userId = req.auth?.user.id;
    if (!userId) throw new AppError('No authenticated user', 401, 'UNAUTHENTICATED');
    const { status_key } = req.body as { status_key: string | null };
    const state = await taskStatusRepo.setOverride(req.params.id!, req.params.taskId!, status_key, userId);
    res.status(StatusCodes.OK).json(ok(state));
  },
};
