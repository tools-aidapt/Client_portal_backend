import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ok } from '@common/utils/api-response.js';
import { taskLinksRepo } from '../repositories/task-links.repository.js';

/**
 * Admin control over the wishlist → Process Onboarding link.
 *
 * A wishlist item that wins a voting cycle is meant to become a real onboarding
 * task, but nothing can match an arbitrary ClickUp task to a wishlist item
 * automatically — the titles differ, and the Pod may split one request across
 * several tasks. So the admin who creates the Process List task states the link
 * here, once, and `GET /onboarding` surfaces it to the client from then on.
 */
export const taskLinksController = {
  /** Wishlist items for this client and the task each is already linked to. */
  async listWishlistItems(req: Request, res: Response): Promise<void> {
    const items = await taskLinksRepo.listLinkableWishlistItems(req.params.id!);
    res.status(StatusCodes.OK).json(ok({ items }));
  },

  /** Set (or clear, with `null`) the wishlist item a cached task originated from. */
  async setWishlistSource(req: Request, res: Response): Promise<void> {
    const { wishlist_item_id } = req.body as { wishlist_item_id: string | null };
    const link = await taskLinksRepo.setWishlistSource(
      req.params.id!,
      req.params.taskId!,
      wishlist_item_id,
    );
    res.status(StatusCodes.OK).json(ok(link));
  },
};
