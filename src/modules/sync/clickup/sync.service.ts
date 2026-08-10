import {
  ClickUpClient,
  partitionReportPages,
  type ClickUpDoc,
  type ClickUpTask,
} from '@infra/clickup/client.js';
import { AppError } from '@common/errors/index.js';
import { logger } from '@infra/logger/index.js';
import { withTransaction } from '@infra/db/pool.js';
import { wishlistRepo } from '@modules/wishlist/wishlist.repository.js';
import { syncRepo } from './sync.repository.js';
import {
  extractClientGroup,
  isProjectList,
  mapClickUpTask,
  type TaskBucket,
  type TaskSource,
} from './mapper.js';
import {
  isMonthlyReportDoc,
  mapReportDoc,
  mapReportSection,
  parseReportPeriod,
} from './report-mapper.js';
import { mapCaseStudyTask, shortListName } from './usecase-mapper.js';
import { mapWishlistTask } from './wishlist-mapper.js';

export interface SyncResult {
  runId: string;
  upserted: number;
  skipped: number;
  status: 'success' | 'partial' | 'error';
  /** Notifications emitted by this run. Only the report sync sets it. */
  notified?: number;
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
        // A list mapped for a shared purpose (the ORG process list behind
        // /onboarding) carries one task per client, so `ingestProject` — which
        // files a whole list under one tenant — must never touch it: doing so
        // put ten other clients' engagements in Kenafric's cache. Its own sync
        // (`syncOnboardingRequests`) routes task-by-task on "Client Group".
        // Checked before the tenant lookup, because the shared list resolves to
        // a tenant precisely by way of that mapping.
        const purpose = await syncRepo.getListPurpose(list.id);
        if (purpose && purpose !== 'project') return;
        const tenantId = folderTenantId ?? (await syncRepo.resolveTenantByListId(list.id));
        if (!tenantId) return; // project not mapped to a client
        // Delivery-ops furniture (onboarding/offboarding checklists, wishlist,
        // reports) sits in the same folder but isn't a client project. Retire
        // any mapping a previous run created rather than just skipping it, or
        // stale rows keep showing on the Projects page forever.
        if (!isProjectList(list.name)) {
          await syncRepo.retireProject(tenantId, list.id);
          return;
        }
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
   * Sync the shared "ORG - Client - Wishlist" list into portal.wishlist_items.
   * One list serves every client — each task routes to a tenant via its
   * "Client Group" field, same as the sprint path. No "Client Visible" gate
   * here: that checkbox has never actually been set on any wishlist task (it's
   * an unused artifact of a workspace-wide custom field template, not a real
   * curation step for this list) — gating on it would sync nothing. Voting
   * stays portal-native; this never touches votes or `state`.
   *
   * The task's `markdown_description` holds the whole intake form, which
   * `mapWishlistTask` parses into the detail columns added in migration `0027`
   * (Problem / Who feels the pain / Urgency / Submitter). Before that the board
   * showed a bare title and nobody could tell what they were voting on.
   */
  async syncWishlist(listId: string): Promise<SyncResult> {
    const runId = await syncRepo.startRun('wishlist', null);
    try {
      const client = new ClickUpClient();
      const tasks = await client.getListTasks(listId);
      const groupTenant = new Map<string, string | null>();
      const profileByEmail = new Map<string, string | null>();
      let upserted = 0;
      let skipped = 0;

      for (const task of tasks) {
        // `getListTasks` passes `subtasks=true`, so a subtask of a submission
        // would otherwise become a wishlist item of its own. None exist on this
        // list today; this keeps it that way if someone ever adds one.
        if (task.parent) {
          skipped++;
          continue;
        }

        const group = extractClientGroup(task);
        // A task with the field unset at all (one exists today) is unroutable —
        // count it rather than guessing a tenant for it.
        const tenantId = group
          ? (groupTenant.has(group)
              ? groupTenant.get(group)!
              : groupTenant.set(group, await syncRepo.resolveTenantByClientGroup(group)).get(group)!)
          : null;
        if (!tenantId) {
          skipped++;
          continue;
        }

        const row = mapWishlistTask(task, { tenantId });

        // Attribute the request to a real portal user when the form's email
        // matches someone in THIS tenant. The email itself is never stored
        // (migration 0027) — only the resolved profile id, in `submitted_by`.
        let submittedBy: string | null = null;
        const email = row.detail.submitterEmail;
        if (email) {
          const key = `${tenantId}:${email}`;
          submittedBy = profileByEmail.has(key)
            ? profileByEmail.get(key)!
            : profileByEmail
                .set(key, await syncRepo.resolveTenantProfileByEmail(tenantId, email))
                .get(key)!;
        }

        await wishlistRepo.upsertFromClickUp({ ...row, submittedBy });
        upserted++;
      }

      const status = skipped > 0 ? 'partial' : 'success';
      await syncRepo.finishRun(runId, status, upserted, skipped ? `${skipped} unrouted/hidden items` : undefined);
      return { runId, upserted, skipped, status };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Sync the shared "ORG - Client - Process List" (engagement/onboarding
   * intake submissions) into task_cache. Same shape as syncWishlist: one list,
   * routed per-task by "Client Group". Requires a `clickup_list_mappings` row
   * per tenant (purpose='onboarding') pointing at this list id before the
   * onboarding page will show anything — the sync itself doesn't need it.
   */
  async syncOnboardingRequests(listId: string): Promise<SyncResult> {
    const runId = await syncRepo.startRun('onboarding', null);
    try {
      const client = new ClickUpClient();
      const statusMapCache = new Map<string, Map<string, TaskBucket>>();
      const groupTenant = new Map<string, string | null>();
      const tasks = await client.getListTasks(listId);
      let upserted = 0;
      let skipped = 0;

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
        let statusMap = statusMapCache.get(tenantId);
        if (!statusMap) statusMap = statusMapCache.set(tenantId, await syncRepo.getStatusMap(tenantId)).get(tenantId)!;
        const row = mapClickUpTask(task, { tenantId, source: 'delivery', statusMap, sprintId: null });
        // Onboarding requests have no separate curation step (unlike projects,
        // where an admin explicitly flips visibility) — the task's own
        // "Client Visible" checkbox is never set here, so force it on rather
        // than hide every submission by default.
        row.clientVisible = true;
        await syncRepo.upsertTask(row);
        upserted++;
      }

      const status = skipped > 0 ? 'partial' : 'success';
      await syncRepo.finishRun(runId, status, upserted, skipped ? `${skipped} unrouted requests` : undefined);
      return { runId, upserted, skipped, status };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * Sync monthly client reports from ClickUp Docs into portal.reports.
   *
   * The source is a ClickUp **Doc**, not a task list. Each client has its own
   * "Monthly Progress Reports" FOLDER in Delivery holding one Doc per month
   * ("KEN - Report - JULY 2026"). That Doc's top-level page is the report body;
   * its child pages are the pillar deep-dives — AI Operations, Intelligence,
   * Enablement — which become `portal.report_sections` rows.
   *
   * Routing is by FOLDER, from `core.tenants.clickup_reports_folder_id`. It
   * cannot use the folder NAME (all five are literally called "Monthly Progress
   * Reports") nor `doc.parent` against `clickup_folder_id` (the reports folder
   * is a SIBLING of the client folder, not the client folder itself), nor the
   * Client Group field (Docs have no custom fields).
   *
   * With no arguments this walks every mapped tenant; `tenantId` / `docId`
   * narrow it for a one-off re-pull.
   */
  async syncReports(
    opts: { tenantId?: string; docId?: string } = {},
  ): Promise<SyncResult & { tenants: number; docs: number; notified: number }> {
    const runId = await syncRepo.startRun('reports', opts.tenantId ?? null);
    try {
      const client = new ClickUpClient();
      const tenants = await syncRepo.listReportsFolderTenants(opts.tenantId);
      if (tenants.length === 0) {
        throw new AppError(
          opts.tenantId
            ? 'Tenant has no clickup_reports_folder_id set'
            : 'No tenant has a reports folder mapped',
          400,
          'NO_REPORTS_FOLDER',
        );
      }

      let upserted = 0;
      let skipped = 0;
      let notified = 0;
      let docCount = 0;
      const problems: string[] = [];

      for (const tenant of tenants) {
        let docs;
        try {
          docs = await client.listFolderDocs(tenant.folderId);
        } catch (err) {
          // One unreachable folder must not starve the other tenants.
          problems.push(`${tenant.name}: folder ${tenant.folderId} unreadable`);
          logger.error({ tenant: tenant.name, err }, 'Report folder listing failed');
          continue;
        }
        if (opts.docId) docs = docs.filter((d) => d.id === opts.docId);

        // Leftovers live in these folders too (Kenafric's "KEN - Monthly Reports"
        // duplicates its real July Doc). Only Docs that name their own month are
        // client reports; the rest are counted and named rather than dropped.
        const notReports = docs.filter((d) => !isMonthlyReportDoc(d.name));
        for (const d of notReports) {
          skipped++;
          problems.push(`${d.name || d.id}: not a monthly report Doc`);
        }
        docs = docs.filter((d) => isMonthlyReportDoc(d.name));

        const seenDocIds: string[] = [];
        let tenantFailures = 0;

        for (const doc of docs) {
          docCount++;
          try {
            const result = await this.syncReportDoc(tenant.id, doc);
            if (result.synced) {
              upserted++;
              seenDocIds.push(doc.id);
            } else {
              skipped++;
              problems.push(`${doc.name || doc.id}: ${result.reason}`);
            }
          } catch (err) {
            tenantFailures++;
            const detail = err instanceof Error ? err.message : String(err);
            problems.push(`${doc.name || doc.id}: ${detail}`);
            logger.error({ docId: doc.id, err }, 'Report doc sync failed');
          }
        }

        // Only retire against a listing we actually trust: after a failed fetch
        // this would archive every report the broken call did not return.
        if (seenDocIds.length > 0 && tenantFailures === 0) {
          await syncRepo.retireMissingSyncedReports(tenant.id, seenDocIds);
        }

        // An admin-published portal-native report outranks the sync; overriding
        // it here would ping-pong the two on every run.
        if (!(await syncRepo.hasNativePublishedReport(tenant.id))) {
          await syncRepo.archiveSupersededSyncedReports(tenant.id);
          // AFTER the archive step, so this reads the one report that is really
          // still published rather than announcing a superseded month.
          notified += await syncRepo.notifyPublishedReport(tenant.id);
        }
      }

      const status = problems.length > 0 ? 'partial' : 'success';
      await syncRepo.finishRun(runId, status, upserted, problems.join('; ') || undefined);
      logger.info(
        { tenants: tenants.length, docs: docCount, upserted, skipped, notified },
        'Monthly report sync complete',
      );
      return { runId, upserted, skipped, notified, status, tenants: tenants.length, docs: docCount };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await syncRepo.finishRun(runId, 'error', 0, detail);
      throw err;
    }
  },

  /**
   * One monthly Doc -> one report plus its sections, in a single transaction.
   *
   * Transactional because a client must never see a report whose sections are
   * half-written; advisory-locked on the doc id because n8n retries overlap and
   * two concurrent runs would race on the orphan-section delete.
   */
  async syncReportDoc(
    tenantId: string,
    doc: ClickUpDoc,
  ): Promise<{ synced: true; reportId: string } | { synced: false; reason: string }> {
    const client = new ClickUpClient();
    const pages = await client.getDocPages(doc.id);
    const { root, sections: sectionPages, extraRoots, orphans } = partitionReportPages(pages);

    const period = parseReportPeriod({
      rootContent: root?.content,
      docName: doc.name,
      rootPageName: root?.name,
    });
    // Never guess a month: a report filed under the wrong period is worse than
    // one the sync refuses and names in sync_runs.
    if (!period) return { synced: false, reason: 'no parseable report period' };

    if (extraRoots.length || orphans.length) {
      logger.warn(
        { docId: doc.id, extraRoots: extraRoots.map((p) => p.id), orphans: orphans.map((p) => p.id) },
        'Report doc has pages outside the expected root/pillar shape',
      );
    }

    const sections = sectionPages.map((page, i) => mapReportSection(page, i));
    const report = mapReportDoc({ tenantId, doc, rootPage: root, period, sections });

    const reportId = await withTransaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [doc.id]);
      const id = await syncRepo.upsertReportFromDoc(tx, report);
      for (const section of sections) {
        await syncRepo.upsertReportSection(tx, id, tenantId, section);
      }
      await syncRepo.deleteOrphanSections(tx, id, sections.map((s) => s.clickupPageId));
      return id;
    });

    logger.info(
      {
        docId: doc.id,
        reportId,
        period: `${period.start}..${period.end}`,
        periodSource: period.source,
        sections: sections.length,
        status: report.status,
      },
      'Report doc synced',
    );
    return { synced: true, reportId };
  },

  /**
   * Sync the "Case Study Library" folder into portal.use_cases.
   *
   * Unlike every other sync here this is TENANT-AGNOSTIC — the library is the
   * same for every client, so there is no Client Group routing and nothing is
   * skipped for being unroutable. `skipped` counts studies withheld because
   * their ClickUp Confidentiality Level is not 'Public'.
   *
   * Walks the FOLDER's lists directly and never the parent space: the service
   * account has folder-level access only (the space itself still returns
   * INSUFFICIENT_ACCESS), so `getSpaceListing` would fail here.
   */
  async syncUseCases(folderId: string): Promise<SyncResult & { lists: number }> {
    const runId = await syncRepo.startRun('use_cases', null);
    try {
      const client = new ClickUpClient();
      const lists = await client.getFolderLists(folderId);
      let upserted = 0;
      let skipped = 0;

      for (const list of lists) {
        const source = shortListName(list.name);
        const tasks = await client.getListTasks(list.id);
        for (const task of tasks) {
          const row = mapCaseStudyTask(task, source);
          await syncRepo.upsertUseCase(row);
          if (row.isPublished) upserted++;
          else skipped++;
        }
      }

      // Every task is stored either way; `skipped` counts those held back from
      // clients (explicitly NDA-required / Internal-only in ClickUp), which is a
      // normal outcome rather than a partial failure.
      await syncRepo.finishRun(
        runId,
        'success',
        upserted,
        skipped ? `${skipped} withheld (NDA-required/Internal-only)` : undefined,
      );
      logger.info({ lists: lists.length, upserted, skipped }, 'Use case library sync complete');
      return { runId, upserted, skipped, status: 'success', lists: lists.length };
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
