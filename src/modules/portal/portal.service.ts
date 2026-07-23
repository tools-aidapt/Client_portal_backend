import { portalRepo } from './portal.repository.js';

function groupByBucket(tasks: Array<Record<string, unknown>>) {
  const buckets: Record<string, Array<Record<string, unknown>>> = {
    delivered: [],
    in_progress: [],
    upcoming: [],
  };
  for (const t of tasks) {
    const b = (t.bucket as string) ?? 'upcoming';
    (buckets[b] ??= []).push(t);
  }
  return buckets;
}

export const portalService = {
  async projects(tenantId: string) {
    const tasks = await portalRepo.deliveryTasks(tenantId);
    return { total: tasks.length, buckets: groupByBucket(tasks) };
  },

  async sprintActive(tenantId: string) {
    const sprint = await portalRepo.activeSprint();
    if (!sprint) return { sprint: null, tasks: [] as Array<Record<string, unknown>> };
    const tasks = await portalRepo.sprintTasks(tenantId, sprint.id);
    return { sprint, tasks };
  },

  async onboarding(tenantId: string) {
    const tasks = await portalRepo.onboardingTasks(tenantId);
    // intake_form_url is not modeled yet; surfaced as null for the frontend.
    return { tasks, intake_form_url: null };
  },

  async pod(tenantId: string) {
    return { members: await portalRepo.pod(tenantId) };
  },

  async dashboard(tenantId: string, userId: string) {
    const [counts, sprint, enablement, support, unread] = await Promise.all([
      portalRepo.deliveryCounts(tenantId),
      this.sprintActive(tenantId),
      portalRepo.enablementSummary(tenantId),
      portalRepo.supportSummary(tenantId),
      portalRepo.unreadCount(userId, tenantId),
    ]);
    return {
      projects: counts,
      sprint,
      tiles: {
        lms: enablement,
        support,
      },
      notifications: { unread },
    };
  },

  async notifications(userId: string, tenantId: string) {
    const [items, unread] = await Promise.all([
      portalRepo.notifications(userId, tenantId),
      portalRepo.unreadCount(userId, tenantId),
    ]);
    return { items, unread };
  },

  async markNotificationRead(id: string, userId: string) {
    return portalRepo.markNotificationRead(id, userId);
  },
};
