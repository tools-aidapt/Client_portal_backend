import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { ok } from '@common/utils/api-response.js';
import { UnauthorizedError } from '@common/errors/index.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { requirePlatformAdmin, requireServiceSecret } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { automationService } from './automation.service.js';

/** Admin: register an n8n workflow for a tenant (design §10.2). */
export const adminAutomationRoutes = Router({ mergeParams: true });

adminAutomationRoutes.post(
  '/',
  authenticate,
  requirePlatformAdmin,
  validate({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      n8n_workflow_id: z.string().trim().min(1),
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(1000).optional(),
      is_client_visible: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body as {
      n8n_workflow_id: string;
      name: string;
      description?: string;
      is_client_visible: boolean;
    };
    const result = await automationService.register({
      tenantId: req.params.id!,
      n8nWorkflowId: b.n8n_workflow_id,
      name: b.name,
      description: b.description,
      isClientVisible: b.is_client_visible,
    });
    res.status(StatusCodes.CREATED).json(ok(result));
  }),
);

/** Client: client-visible automation health (design §10.4, MemberPlus+). */
export const automationHealthRoutes = Router();

automationHealthRoutes.get(
  '/health',
  authenticate,
  requireTenantRole('member_plus'),
  asyncHandler(async (req, res) => {
    if (!req.tenant) throw new UnauthorizedError();
    res.status(StatusCodes.OK).json(ok(await automationService.clientHealth(req.tenant.id)));
  }),
);

/** n8n execution webhook (design §10.6, service secret). */
export const n8nWebhookRoutes = Router();

n8nWebhookRoutes.post(
  '/execution',
  requireServiceSecret,
  validate({
    body: z.object({
      n8n_workflow_id: z.string().trim().min(1),
      status: z.enum(['success', 'error']),
      runtime_ms: z.number().int().min(0).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body as { n8n_workflow_id: string; status: 'success' | 'error'; runtime_ms?: number };
    const result = await automationService.recordExecution(b.n8n_workflow_id, b.status, b.runtime_ms ?? null);
    const code = result.updated > 0 ? StatusCodes.OK : StatusCodes.ACCEPTED;
    res.status(code).json(ok(result));
  }),
);
