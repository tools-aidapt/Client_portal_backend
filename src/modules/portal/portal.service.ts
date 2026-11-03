import { config } from '@config/index.js';
import { portalRepo } from './portal.repository.js';
import { buildLinkedProject, type LinkableProject } from './linked-project.js';
import { parseNameSuffixCapability, parseProjectName } from './project-name.js';
import { accentTone } from './project-tags.js';

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
 * every phase is delivered it takes the most advanced delivered one. A phase whose status the catalogue doesn't know is ignored here
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

/** When a delivered project finished: the latest `closed_at` among its phases, ISO. */
function latestClosedAt(phases: Array<Record<string, unknown>>): string | null {
  const times = phases
    .map((p) => (p.closed_at ? new Date(p.closed_at as Date | string).getTime() : NaN))
    .filter((n) => Number.isFinite(n));
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
}

export const portalService = {
  /**
   * Projects with their phases, plus the status catalogue so the client can
   * label filters without a second request.
   *
   * A project's status is derived from its phases, which carry what ClickUp
   * synced. `status` (the bucket, for tabs and counts) comes from the same place.
   */
  async projects(tenantId: string) {
    const [projects, catalogue, tagsByList] = await Promise.all([
      portalRepo.projects(tenantId),
      portalRepo.taskStatuses(),
      portalRepo.projectTagsByList(tenantId),
    ]);
    return {
      total: projects.length,
      statuses: catalogue,
      projects: projects.map((p) => {
        const fine = projectStatusKey(p.tasks, catalogue);
        const status = projectStatus(p.tasks);
        const { display_name, capability } = parseProjectName(p.name);
        const tags = tagsByList.get(p.clickup_list_id) ?? [];
        return {
          clickup_list_id: p.clickup_list_id,
          name: p.name,
          display_name,
          capability,
          status,
          status_key: fine?.key ?? null,
          status_label: fine?.label ?? null,
          status_tone: fine?.tone ?? null,
          tags,
          accent_tone: accentTone(tags, fine?.tone),
          progress_pct: projectProgress(p.tasks),
          delivered_at: status === 'delivered' ? latestClosedAt(p.tasks) : null,
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
    // Resolve each task's linked project through the Projects computation, so it
    // reads exactly as it does on the Projects page. Only run when something is
    // linked; a project hidden from the client resolves to null.
    const byList = new Map<string, LinkableProject>();
    if (tasks.some((t) => t.project_list_id)) {
      for (const p of (await this.projects(tenantId)).projects) byList.set(p.clickup_list_id, p);
    }
    const rows = tasks.map(({ project_list_id, ...task }) => ({
      ...task,
      linked_project: project_list_id ? buildLinkedProject(byList.get(String(project_list_id))) : null,
      capability: task.parent_task_id ? null : parseNameSuffixCapability(String(task.name ?? '')),
    }));
    return { tasks: rows, statuses, intake_form_url: config.web.onboardingFormUrl ?? null };
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
