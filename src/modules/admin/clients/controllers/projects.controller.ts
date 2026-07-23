import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { NotFoundError } from '@common/errors/index.js';
import { ok } from '@common/utils/api-response.js';
import { syncRepo } from '@modules/sync/clickup/sync.repository.js';
import { syncService } from '@modules/sync/clickup/sync.service.js';

/**
 * Admin control over which client projects (ClickUp lists) appear in the Portal.
 */
export const projectsController = {
  /** List a client's known projects and their portal visibility. */
  async list(req: Request, res: Response): Promise<void> {
    const projects = await syncRepo.listProjects(req.params.id!);
    res.status(StatusCodes.OK).json(ok(projects));
  },

  /** Pull the client's projects from ClickUp (hidden by default) so they can be toggled. */
  async discover(req: Request, res: Response): Promise<void> {
    const discovered = await syncService.discoverProjects(req.params.id!);
    const projects = await syncRepo.listProjects(req.params.id!);
    res.status(StatusCodes.OK).json(ok({ discovered: discovered.length, projects }));
  },

  /** Show or hide a single project in the client's Portal. */
  async setVisibility(req: Request, res: Response): Promise<void> {
    const { is_visible } = req.body as { is_visible: boolean };
    const updated = await syncRepo.setProjectVisibility(
      req.params.id!,
      req.params.listId!,
      is_visible,
    );
    if (!updated) throw new NotFoundError('Project not found for this client (run discover first)');
    res.status(StatusCodes.OK).json(ok({ listId: req.params.listId, is_visible }));
  },
};
