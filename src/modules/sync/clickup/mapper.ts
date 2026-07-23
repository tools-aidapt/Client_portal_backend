import type { ClickUpCustomField, ClickUpTask } from '@infra/clickup/client.js';

/**
 * Custom-field NAMES expected on ClickUp tasks. These reflect the Aidapt
 * Delivery board convention — confirm against the real workspace and adjust
 * here if the field labels differ.
 */
export const FIELD = {
  clientVisible: 'Client Visible',
  typeOfWork: 'Type of Work',
  rag: 'RAG',
  progress: 'Progress',
  clientGroup: 'Client Group',
} as const;

export type TaskSource = 'delivery' | 'sprint';
export type TaskBucket = 'delivered' | 'in_progress' | 'upcoming';
export type Rag = 'green' | 'amber' | 'red';

/** Normalized row ready to upsert into portal.task_cache. */
export interface TaskCacheUpsert {
  tenantId: string;
  clickupTaskId: string;
  source: TaskSource;
  sprintId: string | null;
  clickupListId: string | null;
  listName: string | null;
  name: string;
  statusRaw: string | null;
  bucket: TaskBucket | null;
  rag: Rag | null;
  progressPct: number | null;
  typeOfWork: string | null;
  clientVisible: boolean;
  assigneeNames: string[];
  startDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  closedAt: string | null; // ISO timestamp
  url: string | null;
}

function fieldByName(task: ClickUpTask, name: string): ClickUpCustomField | undefined {
  return task.custom_fields?.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

/** Resolve a drop_down/labels field's selected value to its option name. */
function dropdownName(field: ClickUpCustomField | undefined): string | null {
  if (!field || field.value == null || field.value === '') return null;
  const options = field.type_config?.options ?? [];
  const v = field.value;
  const match =
    options.find((o) => o.id === v) ??
    options.find((o) => typeof v === 'number' && o.orderindex === v) ??
    options.find((o) => String(o.orderindex) === String(v));
  return match?.name ?? (typeof v === 'string' ? v : null);
}

function boolField(field: ClickUpCustomField | undefined): boolean {
  if (!field) return false;
  return field.value === true || field.value === 'true' || field.value === 1 || field.value === '1';
}

function numberField(field: ClickUpCustomField | undefined): number | null {
  if (!field || field.value == null || field.value === '') return null;
  const n = Number(field.value);
  return Number.isFinite(n) ? n : null;
}

/** ClickUp epoch-ms string -> 'YYYY-MM-DD' (date column). */
function toDate(ms: string | null | undefined): string | null {
  if (!ms) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString().slice(0, 10);
}

/** ClickUp epoch-ms string -> ISO timestamp. */
function toTimestamp(ms: string | null | undefined): string | null {
  if (!ms) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

const RAG_VALUES = new Set<Rag>(['green', 'amber', 'red']);

function normalizeRag(value: string | null): Rag | null {
  const v = value?.toLowerCase().trim() as Rag | undefined;
  return v && RAG_VALUES.has(v) ? v : null;
}

/**
 * Map a ClickUp task to a normalized task_cache row. `statusMap` resolves the
 * raw ClickUp status to a client-facing bucket (lowercased keys).
 */
export function mapClickUpTask(
  task: ClickUpTask,
  ctx: {
    tenantId: string;
    source: TaskSource;
    statusMap: Map<string, TaskBucket>;
    sprintId?: string | null;
  },
): TaskCacheUpsert {
  const statusRaw = task.status?.status ?? null;
  const bucket = statusRaw ? (ctx.statusMap.get(statusRaw.toLowerCase()) ?? null) : null;

  return {
    tenantId: ctx.tenantId,
    clickupTaskId: task.id,
    source: ctx.source,
    sprintId: ctx.sprintId ?? null,
    clickupListId: task.list?.id ?? null,
    listName: task.list?.name ?? null,
    name: task.name,
    statusRaw,
    bucket,
    rag: normalizeRag(dropdownName(fieldByName(task, FIELD.rag))),
    progressPct: numberField(fieldByName(task, FIELD.progress)),
    typeOfWork: dropdownName(fieldByName(task, FIELD.typeOfWork)),
    clientVisible: boolField(fieldByName(task, FIELD.clientVisible)),
    assigneeNames: (task.assignees ?? [])
      .map((a) => a.username ?? a.email)
      .filter((x): x is string => Boolean(x)),
    startDate: toDate(task.start_date),
    dueDate: toDate(task.due_date),
    closedAt: toTimestamp(task.date_closed),
    url: task.url ?? null,
  };
}

/** Extract the raw "Client Group" value from a task (used to resolve tenant). */
export function extractClientGroup(task: ClickUpTask): string | null {
  return dropdownName(fieldByName(task, FIELD.clientGroup));
}
