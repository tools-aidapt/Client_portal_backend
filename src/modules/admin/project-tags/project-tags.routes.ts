import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireAidaptStaff } from '@/api/middlewares/authorize.js';
import { validate } from '@/api/middlewares/validate.js';
import { projectTagsController } from '@modules/admin/clients/controllers/project-tags.controller.js';
import { createTagBody } from '@modules/admin/clients/validators/project-tags.validators.js';

/**
 * `/admin/project-tags` — the global tag vocabulary. Its own router for the same
 * reason as /admin/task-statuses: `/admin/clients/:id/...` validates `:id` as a
 * uuid. The per-project assignment lives at
 * `PUT /admin/clients/:id/projects/:listId/tags`, where the tenant scope belongs.
 */
export const projectTagRoutes = Router();

projectTagRoutes.use(authenticate, requireAidaptStaff);

projectTagRoutes.get('/', asyncHandler(projectTagsController.list));
projectTagRoutes.post('/', validate({ body: createTagBody }), asyncHandler(projectTagsController.create));
