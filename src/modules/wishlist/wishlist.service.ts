import { wishlistRepo } from './wishlist.repository.js';

export const wishlistService = {
  async list(tenantId: string, userId: string) {
    const cycle = await wishlistRepo.currentCycle(tenantId);
    const items = await wishlistRepo.items(tenantId, cycle?.id ?? null, userId);
    return { cycle, items };
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
};
