import type { ClickUpCustomField, ClickUpTask } from '@infra/clickup/client.js';

/**
 * Custom-field IDs on the Aidapt ClickUp workspace (9012897228). These are
 * workspace-level "team fields" — the same id is reused across every list in
 * Delivery and Sprint, and it survives a rename. Matching on the visible NAME
 * used to silently break the sync whenever someone relabelled a field (which is
 * how `Type of Work` → `Type of Work (Phoenix)` zeroed out type_of_work), so
 * match on id only.
 *
 * Note `progress` points at "Progress %" (type `automatic_progress`, ClickUp's
 * computed roll-up), NOT the similarly-named "Progress" drop-down
 * (2ec4b065-00f3-4987-bdef-030545e75a7e), which holds At Risk/On Track/Achieved
 * — a health label, not a percentage.
 */
export const FIELD = {
  clientVisible: '51ff3b8c-ba61-42e6-b3c0-1a2ab9c713cc',
  typeOfWork: '8d4da5dc-7505-48cc-ba3e-a48bf1fd37af', // "Type of Work (Phoenix)"
  rag: '65bab230-bcb1-4c9d-9cad-7d27eb0941af',
  progress: '976d84ed-390c-45bb-ba5c-497db2e45eec', // "Progress %"
  clientGroup: '6dbb293b-16a6-4c8c-aa7b-21203d2cdb8a',
} as const;

/**
 * Lists that live inside a client folder but are NOT client projects. Every
 * client folder carries the same delivery-ops furniture — an internal
 * onboarding/offboarding checklist, a wishlist feed, a reports folder — and
 * none of it belongs on the client's Projects page.
 *
 * Excluded by name (matched case-insensitively, trimmed) rather than by a
 * name-prefix allowlist, so a project whose list is named off-convention still
 * shows up instead of silently vanishing. Note the client-facing wishlist and
 * onboarding pages read their own sources (`portal.wishlist_items` and the
 * shared "ORG - Client - Process List"), so excluding these costs them nothing.
 */
const NON_PROJECT_LISTS = new Set([
  'onboarding',
  'offboarding',
  'monthly progress reports',
]);

/** Whether a ClickUp list inside a client folder is a real client project. */
export function isProjectList(listName: string): boolean {
  const n = listName.trim().toLowerCase();
  // Per-client wishlist lists are named "<CODE> - Wishlist" (e.g. "KEN - Wishlist").
  if (n.endsWith('wishlist')) return false;
  return !NON_PROJECT_LISTS.has(n);
}

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
  /** Client-facing title parsed out of an intake-form body; null when absent. */
  displayTitle: string | null;
  statusRaw: string | null;
  bucket: TaskBucket | null;
  rag: Rag | null;
  progressPct: number | null;
  typeOfWork: string | null;
  parentTaskId: string | null;
  clientVisible: boolean;
  assigneeNames: string[];
  startDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  closedAt: string | null; // ISO timestamp
  url: string | null;
}

function fieldById(task: ClickUpTask, id: string): ClickUpCustomField | undefined {
  return task.custom_fields?.find((f) => f.id === id);
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

/**
 * Percentage out of a progress field. ClickUp's `automatic_progress` type
 * carries a nested object (`{ percent_complete: 80 }`) rather than a scalar, so
 * unwrap that first; a plain number/string is still accepted in case the field
 * is ever swapped for a manual one.
 */
function percentField(field: ClickUpCustomField | undefined): number | null {
  if (!field || field.value == null || field.value === '') return null;
  const raw =
    typeof field.value === 'object'
      ? (field.value as { percent_complete?: unknown }).percent_complete
      : field.value;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
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

/**
 * The one line of an intake-form body worth showing a client.
 *
 * Submissions on the shared Process List are named after the company that filed
 * them ("Kenafric", "KENAFRIC INDUSTRIES LIMITED", "Kenafric Industries Ltd" —
 * three distinct, real requests), so the task name alone can't tell two apart.
 * The form's own "Project name" field can.
 *
 * Only that field is taken. The rest of the body is internal Aidapt prose —
 * scoping notes, pricing, pod chatter — and none of it is fit to surface
 * verbatim in a client-facing page, so nothing else from the description is
 * ever stored (the same call made for `wishlist_items.description`).
 */
const PROJECT_NAME_RE = /\*\*Project name:\*\*\s*(.+)/i;

/** The intake form's "Project name" value, or null if the body has no such line. */
export function extractDisplayTitle(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const value = PROJECT_NAME_RE.exec(markdown)?.[1]?.trim();
  return value ? value : null;
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
    displayTitle: extractDisplayTitle(task.markdown_description),
    statusRaw,
    bucket,
    rag: normalizeRag(dropdownName(fieldById(task, FIELD.rag))),
    progressPct: percentField(fieldById(task, FIELD.progress)),
    typeOfWork: dropdownName(fieldById(task, FIELD.typeOfWork)),
    parentTaskId: task.parent ?? null,
    clientVisible: boolField(fieldById(task, FIELD.clientVisible)),
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
  return dropdownName(fieldById(task, FIELD.clientGroup));
}

/** Whether a task's "Client Visible" checkbox is set. */
export function isClientVisible(task: ClickUpTask): boolean {
  return boolField(fieldById(task, FIELD.clientVisible));
}

// ---------------------------------------------------------------------------
// Report Doc pages -> portal.reports
// ---------------------------------------------------------------------------

/**
 * A trailing "02 July 2026" / "31st July 2026". Shared with `report-mapper.ts`,
 * which uses it to recover a period from a Doc or page name when the body has
 * no parseable "Report Period" line.
 */
export const TRAILING_DATE_RE = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})\s*$/;

export const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Month name -> 0-based index, or -1. Accepts "Jul", "July", "JULY". */
export function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

/**
 * Build YYYY-MM-DD, rejecting impossible days ("31 February") by round-tripping
 * through UTC. Null when the parts don't describe a real date.
 */
export function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 0 || month > 11) return null;
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Parse a trailing "02 July 2026" -> "2026-07-02". Null if unparseable. */
export function parseLongDate(text: string): string | null {
  const m = TRAILING_DATE_RE.exec(text);
  if (!m) return null;
  return toIsoDate(Number(m[3]), monthIndex(m[2]!), Number(m[1]));
}

/**
 * Split a markdown table row into trimmed cells.
 * Exported for `wishlist-mapper.ts`, which parses the intake form's Submitter
 * table: table-cell handling is a real bug class (ClickUp emits `| ---| --- |`
 * with no space before the pipe), so both parsers share one implementation
 * rather than keeping two that can silently diverge.
 */
export function tableCells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

export function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Committed/delivered from the report's "Action Item Tracker" table: every
 * tracked action is a commitment, and the ones marked ✅ are delivered. This is
 * the Doc equivalent of `reportsRepo.sprintCounts` (all sprint tasks vs. those
 * in the `delivered` bucket).
 *
 * The tracker's columns are NOT stable across the series — Report 1 is
 * `# | Action Item | Owner | Status` while Report 9 adds `Source` and `Due` —
 * so the status column is located by header name, never by position. Other
 * tables in the report (Risks and Issues) also carry ✅, hence scoping strictly
 * to the tracker section and taking only its first table.
 */
export function parseTrackerCounts(md: string): { committed: number; delivered: number } | null {
  const heading = /^#{1,6}[^\n]*Action Item Tracker[^\n]*$/im.exec(md);
  if (!heading) return null;

  const after = md.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,6}\s/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;

  const lines = section.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.startsWith('|'));
  if (start < 0) return null;
  let end = start;
  while (end < lines.length && lines[end]!.startsWith('|')) end++;

  const rows = lines.slice(start, end).map(tableCells).filter((r) => !isSeparatorRow(r));
  const header = rows.shift();
  if (!header || rows.length === 0) return null;

  const statusCol = header.findIndex((c) => c.toLowerCase() === 'status');
  const delivered = rows.filter((r) =>
    (statusCol >= 0 ? (r[statusCol] ?? '') : r.join(' ')).includes('✅'),
  ).length;
  return { committed: rows.length, delivered };
}

/** A line that opens/continues a markdown block rather than plain paragraph text. */
function isStructuralLine(line: string): boolean {
  const s = line.trim();
  return (
    s === '' ||
    /^[|#>]/.test(s) || // table row, heading, blockquote
    /^([-*_])(\s*\1){2,}\s*$/.test(s) || // thematic break: ---, * * *, ___
    /^[-*+]\s/.test(s) || // bullet / task list
    /^\d+[.)]\s/.test(s) || // ordered list
    /^!\[/.test(s) // standalone image
  );
}

/**
 * Make a ClickUp Doc page render the way the Doc actually looks.
 *
 * ClickUp exports each visual line as a bare newline, but in Markdown
 * consecutive non-blank lines are ONE paragraph joined by soft breaks — so the
 * six-line report header ("**Project:** … **Client:** … **Date:** …") renders as
 * a single run-on sentence in any CommonMark/GFM renderer. Every report in the
 * Kenafric pack hits this (47 line breaks across the 9).
 *
 * The fix is a hard break (two trailing spaces, honoured by every mainstream
 * renderer) on every line of a plain-paragraph run except the last. Structural
 * lines — tables, lists, headings, thematic breaks — and anything inside a
 * fenced code block are left byte-for-byte alone. Tracking fence state matters:
 * ClickUp already fences its pre-formatted content (the Report 2 architecture
 * diagram ships inside a ```markdown fence), and hard-breaking inside a fence
 * would put literal trailing spaces into the rendered code.
 *
 * Line endings are normalised to LF first: ClickUp sends CRLF, and a stray \r
 * inside a GFM table delimiter cell can defeat stricter table parsers.
 *
 * Idempotent — re-running the sync over already-normalised text is a no-op,
 * and it stays correct if the renderer is later switched to `breaks: true`.
 */
export function normalizeDocMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fenced = false;
  let run: string[] = [];

  // Hard-break every line of the run but the last (which already ends the
  // paragraph). Lines that already carry a hard break are left as they are.
  const flushRun = () => {
    if (run.length > 1) {
      out.push(...run.map((l, i) => (i === run.length - 1 || /(\s{2}|\\)$/.test(l) ? l : `${l}  `)));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushRun();
      fenced = !fenced;
      out.push(line);
    } else if (fenced || isStructuralLine(line)) {
      flushRun();
      out.push(line);
    } else {
      run.push(line);
    }
  }
  flushRun();
  return out.join('\n');
}
