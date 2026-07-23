import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { ok, fail } from '@common/utils/api-response.js';
import { BadRequestError } from '@common/errors/index.js';
import { requireServiceSecret } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { ClickUpClient } from '@infra/clickup/client.js';
import { syncService } from './sync.service.js';

/**
 * Internal sync endpoints (design §10.6). Service-secret only; called by
 * cron / n8n, never the browser.
 */
export const syncRoutes = Router();

syncRoutes.use(requireServiceSecret);

const deliveryBody = z.object({ tenant_id: z.string().uuid() });

syncRoutes.post(
  '/delivery',
  validate({ body: deliveryBody }),
  asyncHandler(async (req, res) => {
    const result = await syncService.syncDelivery(req.body.tenant_id);
    res.status(StatusCodes.OK).json(ok(result));
  }),
);

syncRoutes.post(
  '/sprint',
  asyncHandler(async (_req, res) => {
    res.status(StatusCodes.OK).json(ok(await syncService.syncSprint()));
  }),
);

const sprintsBody = z.object({ sprints_folder_id: z.string().optional() });

syncRoutes.post(
  '/sprints',
  validate({ body: sprintsBody }),
  asyncHandler(async (req, res) => {
    const result = await syncService.refreshSprints(req.body.sprints_folder_id);
    res.status(StatusCodes.OK).json(ok(result));
  }),
);

const allBody = z.object({ space_ids: z.array(z.string().min(1)).optional() });

/**
 * Hourly pull sync (the preferred model over per-event webhooks). Hit this on a
 * schedule (n8n Schedule trigger / cron). Walks the configured ClickUp spaces
 * — body `space_ids` overrides CLICKUP_SPACE_IDS — and upserts task_cache.
 */
syncRoutes.post(
  '/all',
  validate({ body: allBody }),
  asyncHandler(async (req, res) => {
    if (!ClickUpClient.isConfigured()) {
      res
        .status(StatusCodes.SERVICE_UNAVAILABLE)
        .json(fail('CLICKUP_NOT_CONFIGURED', 'CLICKUP_API_TOKEN is not set'));
      return;
    }
    const spaceIds = req.body.space_ids ?? config.clickup.spaceIds;
    if (spaceIds.length === 0) {
      res
        .status(StatusCodes.BAD_REQUEST)
        .json(fail('NO_SPACES', 'No spaces to sync: set CLICKUP_SPACE_IDS or pass space_ids'));
      return;
    }
    res.status(StatusCodes.OK).json(ok(await syncService.syncSpaces(spaceIds)));
  }),
);

const taskBody = z.object({ task_id: z.string().min(1) });

/**
 * Ingest a single ClickUp task by id. Designed for an n8n flow:
 * ClickUp event -> n8n -> POST here with the task_id. Fetches the task, routes
 * it to a tenant, and upserts task_cache.
 */
syncRoutes.post(
  '/task',
  validate({ body: taskBody }),
  asyncHandler(async (req, res) => {
    if (!ClickUpClient.isConfigured()) {
      res
        .status(StatusCodes.SERVICE_UNAVAILABLE)
        .json(fail('CLICKUP_NOT_CONFIGURED', 'CLICKUP_API_TOKEN is not set'));
      return;
    }
    const result = await syncService.ingestTaskById(req.body.task_id);
    res.status(StatusCodes.OK).json(ok(result));
  }),
);

/**
 * ClickUp webhook (design §10.6). Verifies the X-Signature HMAC, then reuses
 * the same per-task ingestion. Mounted at /webhooks/clickup by the root router.
 * (Unused when ClickUp is wired through n8n instead.)
 */
export const clickupWebhookRoutes = Router();

function verifyClickUpSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  const secret = config.clickup.webhookSecret;
  if (!secret || !signature || !rawBody) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

clickupWebhookRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!verifyClickUpSignature(req.rawBody, req.header('x-signature'))) {
      res.status(StatusCodes.UNAUTHORIZED).json(fail('BAD_SIGNATURE', 'Invalid webhook signature'));
      return;
    }

    const taskId = (req.body as { task_id?: string }).task_id;
    if (!taskId) throw new BadRequestError('Missing task_id');

    if (!ClickUpClient.isConfigured()) {
      logger.warn('ClickUp webhook received but CLICKUP_API_TOKEN is unset — skipping');
      res.status(StatusCodes.ACCEPTED).json(ok({ skipped: 'clickup_not_configured' }));
      return;
    }

    const result = await syncService.ingestTaskById(taskId);
    if ('skipped' in result) {
      logger.warn({ taskId, reason: result.skipped }, 'ClickUp webhook task not ingested');
      res.status(StatusCodes.ACCEPTED).json(ok(result));
      return;
    }
    res.status(StatusCodes.OK).json(ok(result));
  }),
);
