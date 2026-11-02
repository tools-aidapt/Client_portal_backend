import { config } from '@config/index.js';
import { portalRepo } from './portal.repository.js';

type Bucket = 'delivered' | 'in_progress' | 'upcoming';

/**
 * A project's overall status derived from its phases. Delivered only when every
 * phase is; to be planned only when none has started. Anything in between is in
 * progress: the old "any unstarted phase wins" rule put a project with 12 of 13
 * phases delivered under "To be planned".
 */
function projectStatus(tasks: Array<Record<string, unknown>>): Bucket {
  if (tasks.length === 0) return 'upcoming';
  const buckets = new Set(tasks.map((t) => (t.bucket as Bucket) ?? 'upcoming'));
  if (buckets.size > 1) return 'in_progress';
  return buckets.has('delivered') ? 'delivered' : buckets.has('in_progress') ? 'in_progress' : 'upcoming';
}

type StatusRow = { key: string; label: string; tone: string; bucket: string; sort_order: number };

/**
 * The status a project should READ as, which is finer than its bucket.
 *
 * The bucket says "in progress" for a project whose last open phase is in UAT,
 * which is exactly the complaint that prompted the catalogue. So: the project
 * takes the status of its most advanced phase that is not yet delivered
 * (highest catalogue sort order — UAT beats In progress beats To do). When
 * every phase is delivered it takes the most advanced delivered one (Live over
 * Complete). A phase whose status the catalogue doesn't know is ignored here
 * and still counts through its bucket. No phases: To do.
 */
function projectStatusKey(
  tasks: Array<Record<string, unknown>>,
  catalogue: StatusRow[],
): StatusRow | null {
  const byKey = new Map(catalogue.map((c) => [c.key, c]));
  const known = tasks
    .map((t) => byKey.get(String(t.status_key ?? '')))
    .filter((c): c is StatusRow => Boolean(c));
  if (known.length === 0) return byKey.get('to_do') ?? null;
  const open = known.filter((c) => c.bucket !== 'delivered');
  const pool = open.length > 0 ? open : known;
  return pool.reduce((best, c) => (c.sort_order > best.sort_order ? c : best));
}

/**
 * A project's completion: the average of its phases' `completion_pct`, which
 * the repository derives from Hub statuses (see `completionOf`). Null for a
 * project with no phases, so the UI shows a dash rather than a misleading 0.
 */
function projectProgress(phases: Array<Record<string, unknown>>): number | null {
  const pcts = phases
    .map((p) => Number(p.completion_pct))
    .filter((n) => Number.isFinite(n));
  if (pcts.length === 0) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

export const portalService = {
  /**
   * Projects with their phases, plus the status catalogue so the client can
   * label filters and the staff status menu without a second request.
   *
   * A project's status is staff's manual pin when set, otherwise derived from
   * its phases. `status` (the bucket, for tabs and counts) follows whichever
   * wins, so a project pinned to Complete moves to the Done tab.
   */
  async projects(tenantId: string) {
    const [projects, catalogue] = await Promise.all([
      portalRepo.projects(tenantId),
      portalRepo.taskStatuses(),
    ]);
    const byKey = new Map(catalogue.map((c) => [c.key, c]));
    return {
      total: projects.length,
      statuses: catalogue,
      projects: projects.map((p) => {
        const pinned = p.status_override_key ? (byKey.get(p.status_override_key) ?? null) : null;
        const fine = pinned ?? projectStatusKey(p.tasks, catalogue);
        return {
          clickup_list_id: p.clickup_list_id,
          name: p.name,
          status: pinned ? (pinned.bucket as Bucket) : projectStatus(p.tasks),
          status_key: fine?.key ?? null,
          status_label: fine?.label ?? null,
          status_tone: fine?.tone ?? null,
          status_overridden: pinned !== null,
          status_override_at: pinned ? p.status_override_at : null,
          status_override_by_name: pinned ? p.status_override_by_name : null,
          progress_pct: projectProgress(p.tasks),
          phase_total: p.tasks.length,
          phase_done: p.tasks.filter((t) => t.bucket === 'delivered').length,
          tasks: p.tasks,
        };
      }),
    };
  },

  async sprintActive(tenantId: string) {
    const sprint = await portalRepo.activeSprint();
    if (!sprint) return { sprint: null, tasks: [] as Array<Record<string, unknown>> };
    const tasks = await portalRepo.sprintTasks(
      tenantId,
      sprint.id,
      sprint.starts_on,
      sprint.ends_on,
    );
    return { sprint, tasks };
  },

  async onboarding(tenantId: string) {
    const [tasks, statuses] = await Promise.all([
      portalRepo.onboardingTasks(tenantId),
      portalRepo.taskStatuses(),
    ]);
    // One public form for every client (submissions route by the Client Group
    // picked in the form itself), so it's config, not per-tenant data. Null when
    // unconfigured — the frontend disables the button rather than opening
    // nowhere.
    // `statuses` is the catalogue, so the page can group and label tasks by
    // their real status (Backlog, In progress, Live, …) in catalogue order.
    return { tasks, statuses, intake_form_url: config.web.onboardingFormUrl ?? null };
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
