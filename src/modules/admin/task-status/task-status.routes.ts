import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireAidaptStaff } from '@/api/middlewares/authorize.js';
import { taskStatusController } from '@modules/admin/clients/controllers/task-status.controller.js';

/**
 * `GET /admin/task-statuses` — the global status catalogue, for the picker.
 *
 * Its own router rather than a route under `/admin/clients` because that
 * router's `/:id/...` routes validate `:id` as a uuid, and a literal
 * `/task-statuses` segment would be swallowed by them first. The per-task
 * write stays under `/admin/clients/:id/tasks/:taskId/status`, where the
 * tenant scope belongs.
 */
export const taskStatusRoutes = Router();

taskStatusRoutes.use(authenticate, requireAidaptStaff);

taskStatusRoutes.get('/', asyncHandler(taskStatusController.catalogue));
