import { ClickUpClient, type ClickUpTask } from '@infra/clickup/client.js';
import { AppError } from '@common/errors/index.js';
import { logger } from '@infra/logger/index.js';
import { syncRepo } from './sync.repository.js';
import {
  extractClientGroup,
  mapClickUpTask,
  type TaskBucket,
  type TaskSource,
} from './mapper.js';

export interface SyncResult {
  runId: string;
  upserted: number;
  skipped: number;
  status: 'success' | 'partial' | 'error';
}

/** Parse a leading sprint number out of a list name like "Sprint 5 (7/13 - 7/26)". */
function parseSprintNumber(name: string): number | null {
  const m = name.match(/sprint\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export const syncService = {
  /**
   * Core ingestion: normalize and upsert a batch of ClickUp tasks for one
   * tenant. No ClickUp API dependency — this is the unit the pull and webhook
   * paths both funnel through, and what the tests exercise.
   */
  async ingestTasksForTenant(
    tenantId: string,
    tasks: ClickUpTask[],
    source: TaskSource,
    sprintId: string | null = null,
  ): Promise<number> {
    const statusMap = await syncRepo.getStatusMap(tenantId);
    let n = 0;
    for (const task of tasks) {
      const row = mapClickUpTask(task, { tenantId, source, statusMap, sprintId });
      await syncRepo.upsertTask(row);
      n++;
    }
    return n;
  },

  /**
   * Hourly pull: walk the given ClickUp spaces, upsert every client-relevant
   * task into task_cache. Tasks route to a tenant by their folder (delivery) or
   * Client Group (active-sprint lists); unroutable tasks are skipped and counted.
   *
   * Per-tenant status maps and tenant lookups are cached across the whole run so
   * a large sync issues far fewer DB queries. This is the endpoint the cron/n8n
   * schedule calls.
   */
  async syncSpaces(spaceIds: string[]): Promise<SyncResult & { spaces: number }> {
    const runId = await syncRepo.startRun('spaces', null);
    try {
      const client = new ClickUpClient();
      const statusMapCache = new Map<string, Map<string, TaskBucket>>();
      const visibilityCache = new Map<string, Map<string, boolean>>();
      const groupTenant = new Map<string, string | null>();
      let upserted = 0;
      let skipped = 0;

      const statusMapFor = async (tenantId: string) => {
        let sm = statusMapCache.get(tenantId);
        if (!sm) sm = statusMapCache.set(tenantId, await syncRepo.getStatusMap(tenantId)).get(tenantId)!;
        return sm;
      };
      const visibilityFor = async (tenantId: string) => {
        let vm = visibilityCache.get(tenantId);
        if (!vm) vm = visibilityCache.set(tenantId, await syncRepo.getProjectVisibilityMap(tenantId)).get(tenantId)!;
        return vm;
      };

      // Ingest one list's tasks for a resolved delivery tenant; client_visible is
      // driven by the project's admin-set visibility flag.
      const ingestProject = async (tenantId: string, listId: string, listName: string) => {
        await syncRepo.upsertProject(tenantId, listId, listName);
        const visible = (await visibilityFor(tenantId)).get(listId) ?? false;
        const statusMap = await statusMapFor(tenantId);
        const tasks = await client.getListTasks(listId);
        for (const task of tasks) {
          const row = mapClickUpTask(task, { tenantId, source: 'delivery', statusMap, sprintId: null });
          row.clientVisible = visible; // project-level control overrides the task field
          await syncRepo.upsertTask(row);
          upserted++;
        }
      };

      // Ingest a sprint list: each task routes to a tenant by its Client Group.
      const ingestSprint = async (sprintId: string, listId: string) => {
        const tasks = await client.getListTasks(listId);
        for (const task of tasks) {
          const group = extractClientGroup(task);
          const tenantId = group
            ? (groupTenant.has(group)
                ? groupTenant.get(group)!
                : groupTenant.set(group, await syncRepo.resolveTenantByClientGroup(group)).get(group)!)
            : null;
          if (!tenantId) {
            skipped++;
            continue;
          }
          const statusMap = await statusMapFor(tenantId);
          await syncRepo.upsertTask(mapClickUpTask(task, { tenantId, source: 'sprint', statusMap, sprintId }));
          upserted++;
        }
      };

      const handleList = async (list: { id: string; name: string }, folderTenantId: string | null) => {
        const sprintId = await syncRepo.getActiveSprintByListId(list.id);
        if (sprintId) return ingestSprint(sprintId, list.id);
        const tenantId = folderTenantId ?? (await syncRepo.resolveTenantByListId(list.id));
        if (!tenantId) return; // project not mapped to a client
        await ingestProject(tenantId, list.id, list.name);
      };

      for (const spaceId of spaceIds) {
        const listing = await client.getSpaceListing(spaceId);

        for (const list of listing.folderless) {
          await handleList({ id: list.id, name: list.name }, null);
        }
        for (const folder of listing.folders) {
          // In Delivery, a folder is a client — resolve the tenant once per folder.
          const folderTenantId = await syncRepo.resolveTenantByFolderId(folder.id);
          for (const list of folder.lists) {
            await handleList({ id: list.id, name: list.name }, folderTenantId);
          }
        }
      }

      const status = skipped > 0 ? 'partial' : 'success';
      await syncRepo.finishRun(runId, status, upserted, skipped ? `${skipped} unrouted tasks` : undefined);
      logger.info({ spaces: spaceIds.length, upserted, skipped }, 'Space sync complete');
      return { runId, upserted, skipped, status, spaces: spaceIds.length };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Discover a client's projects from ClickUp (the lists under its Delivery
   * folder) and register them — hidden by default — so an admin can choose which
   * to show. Does not pull tasks.
   */
  async discoverProjects(tenantId: string): Promise<Array<{ listId: string; name: string }>> {
    const folderId = await syncRepo.getTenantFolderId(tenantId);
    if (!folderId) {
      throw new AppError('Tenant has no clickup_folder_id set', 400, 'NO_FOLDER');
    }
    const client = new ClickUpClient();
    const lists = await client.getFolderLists(folderId);
    for (const list of lists) await syncRepo.upsertProject(tenantId, list.id, list.name);
    return lists.map((l) => ({ listId: l.id, name: l.name }));
  },

  /** Pull one project list's tasks for a tenant, honoring its visibility flag. */
  async syncProject(tenantId: string, listId: string): Promise<{ upserted: number; visible: boolean }> {
    const client = new ClickUpClient();
    const visible = (await syncRepo.getProjectVisibilityMap(tenantId)).get(listId) ?? false;
    const statusMap = await syncRepo.getStatusMap(tenantId);
    const tasks = await client.getListTasks(listId);
    for (const task of tasks) {
      const row = mapClickUpTask(task, { tenantId, source: 'delivery', statusMap, sprintId: null });
      row.clientVisible = visible;
      await syncRepo.upsertTask(row);
    }
    return { upserted: tasks.length, visible };
  },

  /** Refresh delivery tasks for a single tenant from its mapped project lists. */
  async syncDelivery(tenantId: string): Promise<SyncResult> {
    const runId = await syncRepo.startRun('delivery', tenantId);
    try {
      const client = new ClickUpClient();
      const listIds = await syncRepo.getDeliveryListIds(tenantId);
      let upserted = 0;
      for (const listId of listIds) {
        const tasks = await client.getListTasks(listId);
        upserted += await this.ingestTasksForTenant(tenantId, tasks, 'delivery');
      }
      await syncRepo.finishRun(runId, 'success', upserted);
      return { runId, upserted, skipped: 0, status: 'success' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Refresh active-sprint tasks. Each sprint list is shared across clients, so
   * tasks are routed to a tenant via their "Client Group" field; tasks whose
   * group resolves to no tenant are skipped (counted).
   */
  async syncSprint(): Promise<SyncResult> {
    const runId = await syncRepo.startRun('sprint', null);
    try {
      const client = new ClickUpClient();
      const sprints = await syncRepo.getActiveSprints();
      let upserted = 0;
      let skipped = 0;
      const tenantCache = new Map<string, string | null>();

      for (const sprint of sprints) {
        const tasks = await client.getListTasks(sprint.clickup_list_id);
        for (const task of tasks) {
          const group = extractClientGroup(task);
          if (!group) {
            skipped++;
            continue;
          }
          let tenantId = tenantCache.get(group);
          if (tenantId === undefined) {
            tenantId = await syncRepo.resolveTenantByClientGroup(group);
            tenantCache.set(group, tenantId);
          }
          if (!tenantId) {
            skipped++;
            continue;
          }
          await this.ingestTasksForTenant(tenantId, [task], 'sprint', sprint.id);
          upserted++;
        }
      }
      const status = skipped > 0 ? 'partial' : 'success';
      await syncRepo.finishRun(runId, status, upserted, skipped ? `${skipped} unrouted tasks` : undefined);
      return { runId, upserted, skipped, status };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Nightly: refresh portal.sprints from the given Sprints folder (if provided)
   * and recompute which sprint is active by date.
   */
  async refreshSprints(sprintsFolderId?: string): Promise<{ upserted: number; active: number }> {
    const runId = await syncRepo.startRun('sprints', null);
    try {
      let upserted = 0;
      if (sprintsFolderId) {
        const client = new ClickUpClient();
        const lists = await client.getFolderLists(sprintsFolderId);
        for (const list of lists) {
          await syncRepo.upsertSprint({
            clickupListId: list.id,
            name: list.name,
            sprintNumber: parseSprintNumber(list.name),
            startsOn: list.start_date ? new Date(Number(list.start_date)).toISOString().slice(0, 10) : null,
            endsOn: list.due_date ? new Date(Number(list.due_date)).toISOString().slice(0, 10) : null,
          });
          upserted++;
        }
      }
      const active = await syncRepo.recomputeActiveSprints();
      await syncRepo.finishRun(runId, 'success', upserted);
      logger.info({ upserted, active }, 'Sprints refreshed');
      return { upserted, active };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Fetch one task from ClickUp by id, route it to a tenant, and upsert it.
   * Shared by the ClickUp webhook and the n8n-driven `/internal/sync/task`
   * endpoint. Returns which tenant/source it landed in, or why it was skipped.
   */
  async ingestTaskById(
    taskId: string,
  ): Promise<{ taskId: string; tenantId: string; source: TaskSource } | { taskId: string; skipped: string }> {
    const client = new ClickUpClient();
    const task = await client.getTask(taskId);
    const listId = task.list?.id ?? null;

    // A task on an active sprint list routes by Client Group; otherwise the
    // delivery list mapping resolves the tenant.
    const sprintId = listId ? await syncRepo.getActiveSprintByListId(listId) : null;
    let tenantId: string | null = null;
    if (sprintId) {
      const group = extractClientGroup(task);
      if (group) tenantId = await syncRepo.resolveTenantByClientGroup(group);
    } else if (listId) {
      tenantId = await syncRepo.resolveTenantByListId(listId);
    }

    if (!tenantId) return { taskId, skipped: 'no_tenant' };

    const source: TaskSource = sprintId ? 'sprint' : 'delivery';
    await this.ingestTasksForTenant(tenantId, [task], source, sprintId);
    return { taskId, tenantId, source };
  },
};

export type { TaskBucket };
