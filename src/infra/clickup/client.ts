import { config } from '@config/index.js';
import { AppError } from '@common/errors/index.js';
import { logger } from '@infra/logger/index.js';

const BASE_URL = 'https://api.clickup.com/api/v2';
/** Docs live on v3 only — there is no v2 equivalent. */
const V3_BASE_URL = 'https://api.clickup.com/api/v3';

/** Raw ClickUp custom field as returned by the API. */
export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
  // `drop_down` options carry `name`; `labels` options carry `label` instead.
  type_config?: { options?: Array<{ id: string; name?: string; label?: string; orderindex?: number }> };
}

/** The subset of a ClickUp task we consume. */
export interface ClickUpTask {
  id: string;
  name: string;
  /** Plain-text task body. Returned by `/list/:id/task` and `/task/:id`. */
  description?: string | null;
  /** Parent task id when this card is a subtask; null on top-level tasks. */
  parent?: string | null;
  status?: { status?: string };
  date_created?: string;
  start_date?: string | null;
  due_date?: string | null;
  date_closed?: string | null;
  url?: string;
  list?: { id: string; name?: string };
  folder?: { id: string; name?: string };
  space?: { id: string };
  assignees?: Array<{ username?: string; email?: string }>;
  custom_fields?: ClickUpCustomField[];
}

export interface ClickUpList {
  id: string;
  name: string;
  start_date?: string | null;
  due_date?: string | null;
}

/**
 * A Doc's parent. `type` is a ClickUp location enum; the two that matter for
 * tenant routing are 5 = folder and 6 = list. (Others seen in the workspace:
 * 4 = space, 7/9 = wiki/template roots, 12 = workspace, 1 = task.)
 */
export interface ClickUpDocParent {
  id: string;
  type: number;
}

export const DOC_PARENT = { folder: 5, list: 6 } as const;

export interface ClickUpDoc {
  id: string;
  name: string;
  parent?: ClickUpDocParent;
  date_created?: number;
  date_updated?: number;
}

/** A page of a Doc. Pages nest arbitrarily deep via `pages`. */
export interface ClickUpDocPage {
  id: string;
  doc_id: string;
  parent_page_id?: string;
  name: string;
  content?: string;
  date_created?: number;
  date_updated?: number;
  pages?: ClickUpDocPage[];
}

/**
 * Thin ClickUp API v2 client. Constructing it requires CLICKUP_API_TOKEN;
 * call sites that only ingest pushed payloads (the webhook) don't need it.
 */
export class ClickUpClient {
  private readonly token: string;

  constructor(token = config.clickup.apiToken) {
    if (!token) {
      throw new AppError('CLICKUP_API_TOKEN is not configured', 500, 'CLICKUP_NOT_CONFIGURED');
    }
    this.token = token;
  }

  static isConfigured(): boolean {
    return Boolean(config.clickup.apiToken);
  }

  private async get<T>(path: string, query?: Record<string, string>, base = BASE_URL): Promise<T> {
    const url = new URL(base + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const res = await fetch(url, { headers: { Authorization: this.token } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ path, status: res.status, body }, 'ClickUp API error');
      throw new AppError(`ClickUp API ${res.status} for ${path}`, 502, 'CLICKUP_UPSTREAM');
    }
    return (await res.json()) as T;
  }

  /** All tasks in a list, following pagination (100/page). */
  async getListTasks(listId: string): Promise<ClickUpTask[]> {
    const out: ClickUpTask[] = [];
    for (let page = 0; ; page++) {
      const data = await this.get<{ tasks: ClickUpTask[]; last_page?: boolean }>(
        `/list/${listId}/task`,
        { page: String(page), subtasks: 'true', include_closed: 'true' },
      );
      out.push(...data.tasks);
      if (data.last_page || data.tasks.length === 0) break;
    }
    return out;
  }

  async getTask(taskId: string): Promise<ClickUpTask> {
    return this.get<ClickUpTask>(`/task/${taskId}`);
  }

  async getFolderLists(folderId: string): Promise<ClickUpList[]> {
    const data = await this.get<{ lists: ClickUpList[] }>(`/folder/${folderId}/list`);
    return data.lists;
  }

  /**
   * Structured listing of a space: folderless lists plus each folder with its
   * lists. In the Delivery space a folder is a client and its lists are projects.
   */
  async getSpaceListing(spaceId: string): Promise<{
    folderless: ClickUpList[];
    folders: Array<{ id: string; name: string; lists: ClickUpList[] }>;
  }> {
    const folderless = await this.get<{ lists: ClickUpList[] }>(`/space/${spaceId}/list`, {
      archived: 'false',
    });
    const folders = await this.get<{ folders: Array<{ id: string; name: string; lists?: ClickUpList[] }> }>(
      `/space/${spaceId}/folder`,
      { archived: 'false' },
    );
    return {
      folderless: folderless.lists ?? [],
      folders: (folders.folders ?? []).map((f) => ({ id: f.id, name: f.name, lists: f.lists ?? [] })),
    };
  }

  // ---- Docs (v3) ----

  private get workspaceId(): string {
    const id = config.clickup.teamId;
    if (!id) {
      throw new AppError('CLICKUP_TEAM_ID is not configured', 500, 'CLICKUP_NOT_CONFIGURED');
    }
    return id;
  }

  /** Doc metadata — notably `parent`, which is how a Doc routes to a tenant. */
  async getDoc(docId: string): Promise<ClickUpDoc> {
    const data = await this.get<{ docs: ClickUpDoc[] }>(
      `/workspaces/${this.workspaceId}/docs`,
      { id: docId },
      V3_BASE_URL,
    );
    const doc = data.docs?.[0];
    if (!doc) throw new AppError(`ClickUp doc ${docId} not found`, 404, 'CLICKUP_DOC_NOT_FOUND');
    return doc;
  }

  /**
   * Every page of a Doc, nested, with markdown content — one request, no
   * pagination. `max_page_depth=-1` means unlimited.
   */
  async getDocPages(docId: string): Promise<ClickUpDocPage[]> {
    return this.get<ClickUpDocPage[]>(
      `/workspaces/${this.workspaceId}/docs/${docId}/pages`,
      { max_page_depth: '-1', content_format: 'text/md' },
      V3_BASE_URL,
    );
  }
}

/** Depth-first flatten of a Doc's nested page tree. */
export function flattenDocPages(pages: ClickUpDocPage[]): ClickUpDocPage[] {
  return pages.flatMap((p) => [p, ...flattenDocPages(p.pages ?? [])]);
}
