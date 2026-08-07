import { portalRepo } from './portal.repository.js';

type Bucket = 'delivered' | 'in_progress' | 'upcoming';

/** A project's overall status derived from its tasks: worst-case wins (any in-progress task beats all-delivered). */
function projectStatus(tasks: Array<Record<string, unknown>>): Bucket {
  if (tasks.length === 0) return 'upcoming';
  const buckets = new Set(tasks.map((t) => (t.bucket as Bucket) ?? 'upcoming'));
  if (buckets.has('in_progress')) return 'in_progress';
  if (buckets.has('upcoming')) return 'upcoming';
  return 'delivered';
}

/**
 * A project's completion, averaged across its phases. Phase percentages come
 * from ClickUp's own "Progress %" roll-up, so this is an average of averages —
 * good enough for a headline bar, and it degrades to null (not a misleading 0)
 * for a project whose phases carry no progress at all.
 */
function projectProgress(phases: Array<Record<string, unknown>>): number | null {
  const pcts = phases
    .map((p) => Number(p.progress_pct))
    .filter((n) => Number.isFinite(n));
  if (pcts.length === 0) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

export const portalService = {
  async projects(tenantId: string) {
    const projects = await portalRepo.projects(tenantId);
    return {
      total: projects.length,
      projects: projects.map((p) => ({
        clickup_list_id: p.clickup_list_id,
        name: p.name,
        status: projectStatus(p.tasks),
        progress_pct: projectProgress(p.tasks),
        phase_total: p.tasks.length,
        phase_done: p.tasks.filter((t) => t.bucket === 'delivered').length,
        tasks: p.tasks,
      })),
    };
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
