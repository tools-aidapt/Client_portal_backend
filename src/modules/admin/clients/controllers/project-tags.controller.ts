import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { UnauthorizedError } from '@common/errors/index.js';
import { portalService } from '@modules/portal/portal.service.js';
import { accentTone } from '@modules/portal/project-tags.js';
import { projectTagsRepo } from '../repositories/project-tags.repository.js';

const actorId = (req: Request): string => {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth.user.id;
};

/** Aidapt-curated tags on a client's projects. Clients read them via GET /projects. */
export const projectTagsController = {
  async list(_req: Request, res: Response): Promise<void> {
    res.status(StatusCodes.OK).json(ok(await projectTagsRepo.list()));
  },

  async create(req: Request, res: Response): Promise<void> {
    const { label, tone } = req.body as { label: string; tone: string };
    res.status(StatusCodes.CREATED).json(ok(await projectTagsRepo.create(label, tone, actorId(req))));
  },

  /** Replace the project's whole tag set; returns it plus the resulting accent tone. */
  async setForProject(req: Request, res: Response): Promise<void> {
    const { tag_ids, primary_tag_id } = req.body as { tag_ids: string[]; primary_tag_id: string | null };
    const tenantId = req.params.id!;
    const listId = req.params.listId!;
    const tags = await projectTagsRepo.replaceForProject(tenantId, listId, tag_ids, primary_tag_id, actorId(req));
    // The fallback accent is the project's status tone, read from the same
    // computation /projects uses. A project hidden from the client is not in it,
    // so its accent is then just the primary tag's tone (or null).
    const { projects } = await portalService.projects(tenantId);
    const statusTone = projects.find((p) => p.clickup_list_id === listId)?.status_tone ?? null;
    res.status(StatusCodes.OK).json(ok({ tags, accent_tone: accentTone(tags, statusTone) }));
  },
};
