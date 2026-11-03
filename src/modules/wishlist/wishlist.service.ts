import { config } from '@config/index.js';
import { portalService } from '@modules/portal/portal.service.js';
import { buildLinkedProject } from '@modules/portal/linked-project.js';
import { wishlistRepo } from './wishlist.repository.js';

export const wishlistService = {
  /**
   * The board plus its cycle context.
   *
   * Returns TWO cycles because the page needs both at once: `cycle` is the open
   * one you can vote in, `last_closed_cycle` carries the winner card. When
   * nothing is open, counts fall back to the most recent closed cycle so the
   * board shows the last real tally instead of a row of zeros.
   */
  async list(tenantId: string, userId: string, filter: { state?: string } = {}) {
    const cycles = await wishlistRepo.cycles(tenantId);
    const cycle = cycles.find((c) => c.is_open) ?? null;
    const lastClosed = cycles.find((c) => !c.is_open) ?? null;
    const countingCycleId = cycle?.id ?? lastClosed?.id ?? null;

    const items = await wishlistRepo.items(
      tenantId,
      countingCycleId,
      cycle?.id ?? null,
      userId,
      filter,
    );
    return {
      cycle,
      last_closed_cycle: lastClosed,
      items: await this.withLinkedProjects(tenantId, items),
      // The public request form. Requests are authored in ClickUp, not here: the
      // form writes to the shared "ORG - Client - Wishlist" list and the item
      // appears on the board at the next sync. One form serves every client
      // (submissions route by the Client Group picked in the form), so it's
      // config, not per-tenant data. Null when unconfigured — the frontend
      // disables the button rather than linking nowhere.
      submit_form_url: config.web.wishlistFormUrl ?? null,
    };
  },

  /**
   * Attach `linked_project` to each item. Reuses the Projects computation so a
   * linked project reads exactly as it does on the Projects page; it is only run
   * when some item is linked. A project hidden from the client resolves to null.
   */
  async withLinkedProjects(tenantId: string, items: Array<Record<string, unknown>>) {
    const byList = new Map<string, Awaited<ReturnType<typeof portalService.projects>>['projects'][number]>();
    if (items.some((i) => i.project_list_id)) {
      const { projects } = await portalService.projects(tenantId);
      for (const p of projects) byList.set(p.clickup_list_id, p);
    }
    return items.map(({ project_list_id, ...item }) => {
      const p = project_list_id ? byList.get(String(project_list_id)) : undefined;
      return {
        ...item,
        linked_project: buildLinkedProject(p),
      };
    });
  },

  async submit(
    tenantId: string,
    userId: string,
    input: { title: string; description?: string; referenceVideoUrl?: string; department?: string },
  ) {
    return wishlistRepo.submit(tenantId, userId, {
      title: input.title,
      description: input.description ?? null,
      referenceVideoUrl: input.referenceVideoUrl ?? null,
      department: input.department ?? null,
    });
  },

  async vote(tenantId: string, itemId: string, userId: string) {
    return wishlistRepo.vote(tenantId, itemId, userId);
  },

  async unvote(tenantId: string, itemId: string, userId: string) {
    return wishlistRepo.unvote(tenantId, itemId, userId);
  },
};
