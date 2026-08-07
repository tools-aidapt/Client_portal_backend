import type { ClickUpDoc, ClickUpDocPage } from '@infra/clickup/client.js';
import {
  monthIndex,
  normalizeDocMarkdown,
  pad2,
  parseLongDate,
  parseTrackerCounts,
  toIsoDate,
} from './mapper.js';

/**
 * Monthly report Docs -> portal.reports + portal.report_sections.
 *
 * One Doc is one month's report for one client. Its root page is the
 * client-facing body (Executive Summary, Pillar Status Snapshot, Consolidated
 * Risks…) and its child pages are the pillar deep-dives — "AI Operations",
 * "Intelligence", "Enablement". Clients carry two or three of them.
 *
 * Tracker/table parsing and markdown normalisation live in `mapper.ts` and are
 * shared with the task and wishlist paths; only report-shaped logic is here.
 */

export type Pillar = 'operations' | 'intelligence' | 'enablement';

/** Normalized row ready to upsert into portal.reports. */
export interface ReportDocUpsert {
  tenantId: string;
  clickupDocId: string;
  clickupPageId: string | null; // the Doc's root page
  title: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  summaryMd: string | null;
  committedCount: number | null;
  deliveredCount: number | null;
  publishedAt: string; // ISO timestamp
  docUpdatedAt: string | null; // ISO timestamp
  status: 'draft' | 'published';
}

/** Normalized row ready to upsert into portal.report_sections. */
export interface ReportSectionUpsert {
  clickupPageId: string;
  pillar: Pillar | null;
  pillarLabel: string;
  pillarOwner: string | null;
  subtitle: string | null;
  bodyMd: string | null;
  committedCount: number | null;
  deliveredCount: number | null;
  sortOrder: number;
}

export interface ReportPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  /** Which fallback produced it — logged so a drifting Doc is visible. */
  source: 'period_line' | 'date_line' | 'doc_name' | 'page_name';
}

// ---------------------------------------------------------------------------
// Period parsing
// ---------------------------------------------------------------------------

/**
 * Every dash ClickUp might emit between two dates. KEN's Docs use an en dash
 * (U+2013), ABL and TCC use a plain hyphen — matching only one silently yields
 * no period at all.
 */
const DASH = '[-\\u2010-\\u2015\\u2212]';
const SEP = `(?:\\s*${DASH}\\s*|\\s+to\\s+)`;
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const MON = '([A-Za-z]{3,})\\.?,?';

const PERIOD_LINE = /^\s*\*\*\s*Report\s+Period\s*:?\s*\*\*\s*(.+?)\s*$/im;
const DATE_LINE = /^\s*\*\*\s*Date\s*:?\s*\*\*\s*(.+?)\s*$/im;
const PILLAR_LINE = /^\s*\*\*\s*Pillar\s*:?\s*\*\*\s*(.+?)\s*$/im;
const PILLAR_OWNER_LINE = /^\s*\*\*\s*Pillar\s+Owner\s*:?\s*\*\*\s*(.+?)\s*$/im;

const ISO_RANGE = new RegExp(`(\\d{4}-\\d{2}-\\d{2})${SEP}(\\d{4}-\\d{2}-\\d{2})`);
const CROSS_MONTH = new RegExp(`${DAY}\\s+${MON}\\s*(\\d{4})?${SEP}${DAY}\\s+${MON}\\s*(\\d{4})`, 'i');
const SAME_MONTH = new RegExp(`${DAY}${SEP}${DAY}\\s+${MON}\\s*(\\d{4})`, 'i');
const MONTH_ONLY = new RegExp(`\\b${MON}\\s*(\\d{4})\\b`, 'i');

/**
 * ClickUp emits non-breaking spaces inside exported header lines, which defeat
 * a plain \s+. Written as an escape rather than the literal character so it
 * stays visible in review.
 */
function despace(text: string): string {
  return text.replace(/\u00A0/g, ' ');
}

/** Last day of a month, as YYYY-MM-DD. */
function monthEnd(year: number, month: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(new Date(Date.UTC(year, month + 1, 0)).getUTCDate())}`;
}

/** The whole calendar month containing `month`/`year`. */
function wholeMonth(year: number, month: number): { start: string; end: string } | null {
  if (month < 0 || month > 11 || !Number.isFinite(year)) return null;
  return { start: `${year}-${pad2(month + 1)}-01`, end: monthEnd(year, month) };
}

/** Last `(...)` group in a string, else the string itself. */
function lastParenthetical(text: string): string {
  const groups = [...text.matchAll(/\(([^()]*)\)/g)];
  return groups.length ? groups[groups.length - 1]![1]!.trim() : text;
}

/**
 * A date range out of one free-text value.
 *
 * The parenthetical is tried first and that is what makes JFX safe: its value is
 * "Weeks 18 to 23 (01-31 July 2026)", and "18 to 23" matches a day range on its
 * own. Narrowing to the bracket removes the ambiguity structurally instead of
 * relying on regex ordering to get lucky.
 */
function parseDateRange(rawValue: string): { start: string; end: string } | null {
  const value = despace(rawValue);
  for (const candidate of [lastParenthetical(value), value]) {
    const hit = matchRange(candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Week numbers are not days. "Weeks 18 to 23 July 2026" means week 18 through
 * week 23 — the whole month — but reads as a 18th-to-23rd day range to every
 * pattern below, which would file five weeks of work as six days. Drop the
 * phrase before matching so it falls through to the month-only rule.
 */
const WEEK_PHRASE = new RegExp(`\\bweeks?\\s+\\d+(?:${SEP}\\d+)?`, 'gi');

function matchRange(raw: string): { start: string; end: string } | null {
  const text = raw.replace(WEEK_PHRASE, ' ');
  // ISO first: its internal hyphens would otherwise be read as the separator.
  const iso = ISO_RANGE.exec(text);
  if (iso) return ordered(iso[1]!, iso[2]!);

  // Cross-month before same-month, or "28 July 2026 - 03 August 2026" parses as
  // day 28 -> day 2026.
  const cross = CROSS_MONTH.exec(text);
  if (cross) {
    const endYear = Number(cross[6]);
    const start = toIsoDate(Number(cross[3] ?? cross[6]), monthIndex(cross[2]!), Number(cross[1]));
    const end = toIsoDate(endYear, monthIndex(cross[5]!), Number(cross[4]));
    if (start && end) return ordered(start, end);
  }

  const same = SAME_MONTH.exec(text);
  if (same) {
    const year = Number(same[4]);
    const month = monthIndex(same[3]!);
    const start = toIsoDate(year, month, Number(same[1]));
    const end = toIsoDate(year, month, Number(same[2]));
    if (start && end) return ordered(start, end);
  }

  // "July 2026" with no days -> the whole month. The MONTHS lookup is what stops
  // this matching "Weeks 18" or a bare year.
  const monthOnly = MONTH_ONLY.exec(text);
  if (monthOnly) {
    const whole = wholeMonth(Number(monthOnly[2]), monthIndex(monthOnly[1]!));
    if (whole) return whole;
  }
  return null;
}

function ordered(start: string, end: string): { start: string; end: string } | null {
  return end < start ? null : { start, end };
}

/**
 * The month a report covers.
 *
 * Tried in strict priority order, and never defaulting to "now": a report filed
 * under the wrong month is worse than one the sync refuses and reports.
 *
 * The fallbacks are not hypothetical. Trojan's Doc (8ckbtec-241092) has a single
 * page with an empty name and no content at all, so only `docName` can date it;
 * the legacy Kenafric Doc's root page is named "Kenafric Monthly Report 1 - 31st
 * July 2026" while its Doc is named "KEN - Monthly Reports", so only the page
 * name can.
 *
 * Parse the RAW page content, before `normalizeDocMarkdown` — normalisation
 * appends two trailing spaces to every line of the header run.
 */
export function parseReportPeriod(input: {
  rootContent?: string | null;
  docName?: string | null;
  rootPageName?: string | null;
}): ReportPeriod | null {
  const content = despace(input.rootContent ?? '');

  const periodValue = PERIOD_LINE.exec(content)?.[1];
  if (periodValue) {
    const range = parseDateRange(periodValue);
    if (range) return { ...range, source: 'period_line' };
  }

  // A single "Date:" is the report's issue date — take the month around it.
  const dateValue = DATE_LINE.exec(content)?.[1];
  if (dateValue) {
    const day = parseLongDate(dateValue.trim());
    if (day) {
      const [y, m] = day.split('-').map(Number);
      const whole = wholeMonth(y!, m! - 1);
      if (whole) return { ...whole, source: 'date_line' };
    }
    const range = parseDateRange(dateValue);
    if (range) return { ...range, source: 'date_line' };
  }

  for (const [name, source] of [
    [input.docName, 'doc_name'],
    [input.rootPageName, 'page_name'],
  ] as const) {
    if (!name?.trim()) continue;
    // A trailing "- 31st July 2026" is a date, not a range.
    const day = parseLongDate(despace(name));
    if (day) {
      const [y, m] = day.split('-').map(Number);
      const whole = wholeMonth(y!, m! - 1);
      if (whole) return { ...whole, source };
    }
    const range = parseDateRange(name);
    if (range) return { ...range, source };
  }

  return null;
}

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Whether a Doc in a Monthly Progress Reports folder is actually a month's
 * report.
 *
 * The folders also hold leftovers — Kenafric's "KEN - Monthly Reports" is a
 * duplicate of the real July Doc that was never cleared out, and syncing it gave
 * the client two identical July entries. Requiring the Doc's OWN name to carry
 * both the word "report" and a month + year is what separates
 * "KEN - Report - JULY 2026" from "KEN - Monthly Reports", and it keeps working
 * for August without anyone maintaining a list of ids.
 *
 * Deliberately not falling back to page names or body content here: a Doc that
 * cannot say which month it covers in its own title is not one a client should
 * see, and skipping it is counted and named in `sync_runs`.
 */
export function isMonthlyReportDoc(docName: string | null | undefined): boolean {
  if (!docName || !/report/i.test(docName)) return false;
  const m = MONTH_ONLY.exec(despace(docName));
  return m ? monthIndex(m[1]!) >= 0 : false;
}

/** "July 2026" for a period, used to name a report that has no usable title. */
export function monthLabel(periodEnd: string): string {
  const [y, m] = periodEnd.split('-').map(Number);
  return `${FULL_MONTHS[(m ?? 1) - 1] ?? ''} ${y}`;
}

// ---------------------------------------------------------------------------
// Body cleanup
// ---------------------------------------------------------------------------

/**
 * Drop the `**Client:** / **Report Period:** / **Date:**` block every page opens
 * with. It repeats verbatim on the root page and on all three pillar pages, so
 * rendered as-is the client reads the same metadata four times over. Everything
 * useful in it is already a column by the time this runs.
 *
 * Only the leading run of `**Label:** value` lines is removed — the italic
 * `_Scope in this engagement: …_` line that follows on pillar pages is real
 * content and stays.
 */
export function stripHeaderBlock(md: string): string {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === '' || /^\*\*[^*]+:\*\*/.test(line)) i++;
    else break;
  }
  // A thematic break left stranded at the top would render as a leading rule.
  while (i < lines.length && (lines[i]!.trim() === '' || /^([-*_])(\s*\1){2,}\s*$/.test(lines[i]!.trim()))) i++;
  return lines.slice(i).join('\n');
}

/**
 * Remove a `## <heading>` section and everything under it, up to the next
 * heading of the same or higher level.
 */
export function stripSection(md: string, heading: RegExp): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (start < 0) return md;
  const level = (/^(#{1,6})\s/.exec(lines[start]!)?.[1] ?? '##').length;
  let end = start + 1;
  while (end < lines.length) {
    const m = /^(#{1,6})\s/.exec(lines[end]!);
    if (m && m[1]!.length <= level) break;
    end++;
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // Collapse the blank-line pileup the removal leaves behind.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A report body, ready to store.
 *
 * "Deep-Dive Links" is stripped because those links are broken at source — the
 * five July Docs were duplicated from a template and the links were never
 * rewritten, so JFX's root points at doc 8ckbtec-239852 while its real pages are
 * 8ckbtec-220252/…272, and TCC's points at 8ckbtec-239812. They are also
 * redundant: the portal renders those pillar pages inline, one scroll below.
 */
export function cleanReportBody(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let md = stripHeaderBlock(despace(raw));
  md = stripSection(md, /Deep[-\s]?Dive\s+Links/i);
  return normalizeDocMarkdown(md).trim() || null;
}

// ---------------------------------------------------------------------------
// Doc / page -> rows
// ---------------------------------------------------------------------------

const PILLARS: Array<[Pillar, RegExp]> = [
  ['operations', /operations/i],
  ['intelligence', /intelligence/i],
  ['enablement', /enablement/i],
];

/**
 * The capability a pillar page belongs to. Null rather than a guess when the
 * page is something else — an unrecognised child page must not fail the sync,
 * and `pillar_label` keeps the source wording either way.
 */
export function normalizePillar(label: string | null | undefined): Pillar | null {
  if (!label) return null;
  return PILLARS.find(([, re]) => re.test(label))?.[0] ?? null;
}

/** Map one pillar page to a portal.report_sections row. */
export function mapReportSection(page: ClickUpDocPage, sortOrder: number): ReportSectionUpsert {
  const raw = despace(page.content ?? '');
  // Counts come off the raw export: normalisation only touches paragraph line
  // breaks, but keeping the two independent means neither can break the other.
  const counts = parseTrackerCounts(raw);
  const pillarLabel = (PILLAR_LINE.exec(raw)?.[1] ?? page.name ?? '').trim();

  return {
    clickupPageId: page.id,
    pillar: normalizePillar(pillarLabel || page.name),
    pillarLabel: pillarLabel || page.name || 'Section',
    pillarOwner: PILLAR_OWNER_LINE.exec(raw)?.[1]?.trim() || null,
    subtitle: page.sub_title?.trim() || null,
    bodyMd: cleanReportBody(raw),
    committedCount: counts?.committed ?? null,
    deliveredCount: counts?.delivered ?? null,
    sortOrder,
  };
}

/**
 * Month totals for the header tiles: the pillar trackers added up.
 *
 * Sections with no tracker contribute nothing, and if NO section had one the
 * result is null rather than zero — "nobody tracked anything" and "everything
 * tracked came to zero" must not look the same on a client's screen.
 */
export function sumTrackerCounts(
  sections: ReportSectionUpsert[],
): { committed: number | null; delivered: number | null } {
  const tracked = sections.filter((s) => s.committedCount != null || s.deliveredCount != null);
  if (tracked.length === 0) return { committed: null, delivered: null };
  return {
    committed: tracked.reduce((n, s) => n + (s.committedCount ?? 0), 0),
    delivered: tracked.reduce((n, s) => n + (s.deliveredCount ?? 0), 0),
  };
}

/**
 * Map a Doc plus its root page to a portal.reports row.
 *
 * `title` prefers the Doc name over the root page name: Trojan's root page is
 * named "" and would insert an empty title into a not-null column.
 *
 * An empty Doc is stored as a `draft` — the row exists so the sync is traceable
 * and idempotent, but a client never sees a blank report, and it promotes itself
 * the moment someone actually writes the Doc.
 */
export function mapReportDoc(ctx: {
  tenantId: string;
  doc: ClickUpDoc;
  rootPage: ClickUpDocPage | null;
  period: ReportPeriod;
  sections: ReportSectionUpsert[];
}): ReportDocUpsert {
  const { tenantId, doc, rootPage, period, sections } = ctx;
  const summaryMd = cleanReportBody(rootPage?.content);
  const counts = sumTrackerCounts(sections);
  const isEmpty = !summaryMd && sections.length === 0;

  return {
    tenantId,
    clickupDocId: doc.id,
    clickupPageId: rootPage?.id ?? null,
    title: doc.name?.trim() || rootPage?.name?.trim() || `Report — ${monthLabel(period.end)}`,
    periodStart: period.start,
    periodEnd: period.end,
    summaryMd,
    committedCount: counts.committed,
    deliveredCount: counts.delivered,
    // The month it covers, not when ClickUp last touched the page: these Docs
    // are written up after the fact and several were backfilled in one batch.
    publishedAt: `${period.end}T00:00:00.000Z`,
    docUpdatedAt: doc.date_updated ? new Date(Number(doc.date_updated)).toISOString() : null,
    status: isEmpty ? 'draft' : 'published',
  };
}
