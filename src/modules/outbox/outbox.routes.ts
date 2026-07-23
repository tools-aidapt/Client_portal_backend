import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '@common/utils/async-handler.js';
import { ok } from '@common/utils/api-response.js';
import { requireServiceSecret } from '@/api/middlewares/authorize.js';
import { drainOnce } from './worker.js';

/**
 * Internal outbox endpoint (design §10.6). Called by cron/n8n with the shared
 * service secret; never by the browser. Alternatively run the standalone worker
 * loop (`npm run worker:outbox`).
 */
export const outboxRoutes = Router();

outboxRoutes.post(
  '/drain',
  requireServiceSecret,
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    const summary = await drainOnce(Number.isFinite(limit) ? limit : 20);
    res.status(StatusCodes.OK).json(ok(summary));
  }),
);
