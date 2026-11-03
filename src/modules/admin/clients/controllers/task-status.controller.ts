import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { taskStatusRepo } from '../repositories/task-status.repository.js';

/** The status catalogue. Statuses are not editable per task: they come from ClickUp. */
export const taskStatusController = {
  /** The status catalogue the picker offers. */
  async catalogue(_req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok({ statuses: await taskStatusRepo.catalogue() }));
  },
};
