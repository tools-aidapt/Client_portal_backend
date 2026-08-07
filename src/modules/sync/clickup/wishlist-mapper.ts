import type { ClickUpTask } from '@infra/clickup/client.js';
import { isSeparatorRow, tableCells } from './mapper.js';

/**
 * Parser for the client wishlist intake form.
 *
 * Every task on the shared "ORG - Client - Wishlist" list is one submission, and
 * the whole request lives in the task's `markdown_description` as a
 * semi-templated form. Verified shape across all 14 live tasks (2026-08-07):
 *
 *   ## <title>
 *   **OS Pillar:** ProductivityOS          <- or **Capability:** / **Capability :**
 *   **Urgency:** This quarter, it's blocking us
 *   **Who feels the pain:** HR Department
 *
 *   * * *
 *
 *   ### Problem
 *   ### Notes from submitter
 *   ### Submitter                          <- a two-column | Field | Value | table
 *   ### Year-review priorities (top 3 …)   <- optional, AFTER Submitter on 5 of 14
 *   _Wish 1 of 1 from this submission._    <- generated footer, sometimes absent
 *
 * Nothing here throws: an unrecognised body yields all-null fields and the
 * caller keeps the redacted markdown in `body_md`, so the request still reaches
 * the client verbatim instead of vanishing. Same degradation contract as
 * `parseCaseStudySections` in usecase-mapper.ts.
 */

/** Parsed request detail. Null means absent, blank, or a form placeholder. */
export interface WishlistDetail {
  problem: string | null;
  whoFeelsPain: string | null;
  urgency: string | null;
  submitterNotes: string | null;
  submitterName: string | null;
  submitterRole: string | null;
  /** Used in memory to resolve `submitted_by`; deliberately NEVER persisted. */
  submitterEmail: string | null;
  submitterCompany: string | null;
  /** ISO timestamp, or null when the form's value wasn't a real date. */
  submittedAt: string | null;
  /** Redacted verbatim fallback. Null when nothing survives redaction. */
  bodyMd: string | null;
}

/** A wishlist row ready to upsert. `tenantId` is resolved by the caller. */
export interface WishlistItemUpsert {
  tenantId: string;
  clickupTaskId: string;
  title: string;
  createdAt: string | null;
  detail: WishlistDetail;
}

const EMPTY: WishlistDetail = {
  problem: null,
  whoFeelsPain: null,
  urgency: null,
  submitterNotes: null,
  submitterName: null,
  submitterRole: null,
  submitterEmail: null,
  submitterCompany: null,
  submittedAt: null,
  bodyMd: null,
};

/**
 * Values the form emits to mean "unanswered". Kept deliberately TIGHT and
 * matched only as a whole value: anything looser starts eating real answers.
 *
 * Note "nothing" is NOT here. It appears as a genuine reply under "Notes from
 * submitter" on a live task — a human typing "no notes", not a placeholder.
 * "—" (Urgency, 5 tasks) and "None" (Who feels the pain, 1 task) ARE
 * placeholders and are nulled.
 */
const SENTINELS = new Set(['', '-', '--', '—', '–', 'n/a', 'na', 'none', 'tbd', 'not sure', '?']);

/**
 * Retired vocabulary that must never reach a client surface: the four-OS
 * framework and "AIOS" are retired, and 9 of 14 live bodies still say
 * "ProductivityOS" or "DataOS". These are STRIPPED, not translated — mapping
 * them onto Operations/Intelligence/Enablement would be inventing a mapping,
 * exactly what migration 0022 declined to do for case studies.
 */
const RETIRED_TAXONOMY =
  /\b(AIOS|ProductivityOS|DataOS|PeopleOS|RevenueOS|GrowthOS|AI Operations|Cross Department)\b/gi;

/** The pillar/capability line, in every variant seen. Matched only to delete it. */
const PILLAR_LINE = /^[ \t]*\*\*[ \t]*(?:OS Pillar|Capability)[ \t]*:?[ \t]*\*\*[ \t]*:?.*$/gim;

/** The form's own footer, e.g. "_Wish 1 of 1 from this submission._" */
const WISH_FOOTER = /^[ \t]*_?Wish \d+ of \d+ from this submission\._?[ \t]*$/gim;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Normalise a raw form value: trim, unwrap one layer of emphasis, null sentinels. */
export function normaliseSentinel(value: string | null | undefined): string | null {
  if (value == null) return null;
  let v = value.replace(/\r/g, '').trim();
  // ClickUp forms sometimes emit `_None_` / `**—**`.
  const wrapped = /^([*_`]{1,2})([\s\S]+)\1$/.exec(v);
  if (wrapped) v = wrapped[2]!.trim();
  return SENTINELS.has(v.toLowerCase()) ? null : v || null;
}

export function containsRetiredTaxonomy(text: string | null | undefined): boolean {
  if (!text) return false;
  RETIRED_TAXONOMY.lastIndex = 0;
  return RETIRED_TAXONOMY.test(text);
}

/** An inline `**Label:** value` line, capturing the label and the value. */
const INLINE_FIELD_LINE = /^[ \t]*\*\*[ \t]*([^*\n:]+?)[ \t]*:?[ \t]*\*\*[ \t]*:?[ \t]*(.*)$/;

/**
 * Fields and sections that already have their own parsed column, and therefore
 * their own labelled section in the UI. They are dropped from `body_md` so the
 * fallback is only ever the part of a body we did NOT understand — otherwise a
 * request would render its problem and its submitter twice.
 */
const PARSED_INLINE_LABELS = new Set(['urgency', 'who feels the pain']);
const PARSED_SECTIONS = new Set(['problem', 'notes from submitter', 'submitter']);

/** A horizontal rule on its own line: `* * *`, `---`, `___`. */
const HR_LINE = /^[ \t]*(?:\*[ \t]*\*[ \t]*\*[ \t]*|-{3,}|_{3,})[ \t]*$/;

/**
 * Strip everything that shouldn't reach a client, then tidy the whitespace that
 * removal leaves behind. Applied to `body_md`, which IS rendered to clients (as
 * markdown) whenever parsing produced nothing.
 *
 * Removed:
 *  - the pillar/capability line and any retired taxonomy (never translated);
 *  - the form's generated `_Wish 1 of 1_` footer;
 *  - the leading `## <title>` — the UI already shows the request title above this;
 *  - every field and section that HAS its own parsed column, since each is rendered
 *    as its own labelled section; leaving them here would show the problem and the
 *    submitter twice. What's left is exactly the part we didn't understand, which is
 *    all a fallback should be;
 *  - inline fields and whole `###` sections whose value is a PLACEHOLDER. Without
 *    this the fallback renders "Urgency: —" and "Problem / None" verbatim, which is
 *    precisely what nulling the sentinels in the parsed fields exists to prevent;
 *  - horizontal rules left stranded by the above, and any leading/trailing ones.
 */
export function redactBody(markdown: string): string {
  const cleaned = markdown
    .replace(/\r\n/g, '\n')
    .replace(PILLAR_LINE, '')
    .replace(WISH_FOOTER, '')
    .replace(RETIRED_TAXONOMY, '');

  // Walk block by block so a heading and its (empty) body are dropped together.
  const lines = cleaned.split('\n');
  const kept: string[] = [];
  let index = 0;
  let seenContent = false;
  let titleTaken = false;

  while (index < lines.length) {
    const line = lines[index]!;
    const heading = /^[ \t]*(#{1,6})[ \t]*(.*)$/.exec(line);

    if (heading) {
      // The leading `## <title>` duplicates the heading the UI already shows. Drop
      // just that LINE and keep walking: the inline `**Urgency:**` fields sit under
      // it, so treating it as a section and dropping its body would take them too.
      if (!titleTaken && !seenContent && heading[1]!.length <= 2) {
        titleTaken = true;
        index++;
        continue;
      }

      // Otherwise: collect the section body (up to the next heading of any level)
      // and drop heading + body together when it's a section we already parse into
      // its own column, or when the body was only a placeholder.
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && !/^[ \t]*#{1,6}[ \t]*\S/.test(lines[cursor]!)) {
        body.push(lines[cursor]!);
        cursor++;
      }
      const label = heading[2]!.replace(/[*_`#]/g, '').trim().toLowerCase();
      const meaningful = body.filter((l) => !HR_LINE.test(l)).join('\n');
      if (!PARSED_SECTIONS.has(label) && normaliseSentinel(meaningful) !== null) {
        kept.push(line, ...body);
        seenContent = true;
      }
      index = cursor;
      continue;
    }

    const inline = INLINE_FIELD_LINE.exec(line);
    if (inline) {
      const label = inline[1]!.trim().toLowerCase();
      if (!PARSED_INLINE_LABELS.has(label) && normaliseSentinel(inline[2]) !== null) {
        kept.push(line);
        seenContent = true;
      }
      index++;
      continue;
    }

    if (line.trim()) seenContent = true;
    kept.push(line);
    index++;
  }

  let out = kept
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Rules the removals left stranded at either end. Trim first, then strip, in a
  // loop: dropping the sections between two rules can leave several adjacent, and
  // an anchored pattern can't see past the blank lines they sit among.
  const LEADING_RULE = /^(?:\*[ \t]*\*[ \t]*\*|-{3,}|_{3,})[ \t]*(?:\n|$)/;
  const TRAILING_RULE = /(?:^|\n)[ \t]*(?:\*[ \t]*\*[ \t]*\*|-{3,}|_{3,})[ \t]*$/;
  while (LEADING_RULE.test(out)) out = out.replace(LEADING_RULE, '').trim();
  while (TRAILING_RULE.test(out)) out = out.replace(TRAILING_RULE, '').trim();

  return out;
}

/**
 * Read an inline `**Label:** value` field. Tolerates the colon inside or outside
 * the bold and whitespace on either side of it — the live corpus contains
 * `**Urgency:**`, `**Capability:**` and `**Capability :**`.
 */
export function inlineField(markdown: string, labels: readonly string[]): string | null {
  const text = markdown.replace(/\r\n/g, '\n');
  for (const label of labels) {
    const re = new RegExp(
      `^[ \\t]*\\*\\*[ \\t]*${escapeRe(label)}[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?[ \\t]*(.*)$`,
      'im',
    );
    const m = re.exec(text);
    if (m) return normaliseSentinel(m[1]);
  }
  return null;
}

/**
 * The body of a `### Heading` section, sliced to the NEXT HEADING OF ANY LEVEL.
 *
 * "Any level" is load-bearing, not defensive: `### Year-review priorities` sits
 * between known headings on 5 of 14 tasks (after `### Submitter`), so slicing to
 * the next *known* heading would swallow it into whichever section preceded it.
 */
function section(markdown: string, label: string): string | null {
  const text = markdown.replace(/\r\n/g, '\n');
  const head = new RegExp(`^[ \\t]*#{1,6}[ \\t]*${escapeRe(label)}[ \\t]*$`, 'im').exec(text);
  if (!head) return null;

  const after = text.slice(head.index + head[0].length);
  const nextHeading = /^[ \t]*#{1,6}[ \t]+\S/m.exec(after);
  let body = nextHeading ? after.slice(0, nextHeading.index) : after;

  body = body
    // A horizontal rule ends the section: everything past it belongs to the form,
    // not to this answer. `* * *`, `---` and `___` all appear.
    .replace(/\n[ \t]*(?:\*[ \t]*\*[ \t]*\*[ \t]*|-{3,}|_{3,})[ \t]*(?:\n[\s\S]*)?$/, '')
    .replace(WISH_FOOTER, '');

  return normaliseSentinel(body);
}

/**
 * A `| Field | Value |` table as a lowercased-key map. Header and separator rows
 * are dropped; keys keep only their text so `| **Name** |` still matches `name`.
 */
export function parseKeyValueTable(sectionText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of sectionText.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = tableCells(line);
    if (cells.length < 2 || isSeparatorRow(cells)) continue;
    const key = cells[0]!.replace(/[*_`]/g, '').trim().toLowerCase();
    if (!key || key === 'field') continue;
    out.set(key, cells[1]!.trim());
  }
  return out;
}

/** `[a@b.co](mailto:a@b.co)` or a bare address -> `a@b.co`. Null if neither. */
function parseEmail(value: string | null): string | null {
  const v = normaliseSentinel(value);
  if (!v) return null;
  const linked = /^\[([^\]]+)\]\(mailto:[^)]*\)$/.exec(v);
  const candidate = (linked ? linked[1]! : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

/** An ISO timestamp, or null when the form's value isn't a real date. */
function parseSubmittedAt(value: string | null): string | null {
  const v = normaliseSentinel(value);
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parse an intake-form body. Never throws; unknown shapes come back all-null. */
export function parseWishlistBody(markdown: string | null | undefined): WishlistDetail {
  const raw = (markdown ?? '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return { ...EMPTY };

  const submitterSection = section(raw, 'Submitter') ?? '';
  const table = parseKeyValueTable(submitterSection);

  const detail: WishlistDetail = {
    problem: section(raw, 'Problem'),
    whoFeelsPain: inlineField(raw, ['Who feels the pain']),
    // The pillar/capability line is never read — see RETIRED_TAXONOMY.
    urgency: inlineField(raw, ['Urgency']),
    submitterNotes: section(raw, 'Notes from submitter'),
    submitterName: normaliseSentinel(table.get('name')),
    submitterRole: normaliseSentinel(table.get('role')),
    submitterEmail: parseEmail(table.get('email') ?? null),
    submitterCompany: normaliseSentinel(table.get('company')),
    submittedAt: parseSubmittedAt(table.get('submitted at') ?? null),
    bodyMd: null,
  };

  const redacted = redactBody(raw);
  detail.bodyMd = redacted || null;

  // Belt and braces: a retired term inside a parsed field (not just the pillar
  // line) would otherwise ride straight onto a client screen.
  for (const key of [
    'problem',
    'whoFeelsPain',
    'urgency',
    'submitterNotes',
    'submitterRole',
    'submitterCompany',
  ] as const) {
    const value = detail[key];
    if (value && containsRetiredTaxonomy(value)) {
      detail[key] = normaliseSentinel(value.replace(RETIRED_TAXONOMY, '').replace(/\s{2,}/g, ' '));
    }
  }

  return detail;
}

/** Map a ClickUp wishlist task to an upsert row. */
export function mapWishlistTask(task: ClickUpTask, ctx: { tenantId: string }): WishlistItemUpsert {
  // `markdown_description` is the only usable body: `text_content` renders the
  // Submitter table as `[table-embed:…]`, losing the whole block, and plain
  // `description` drops the table pipes. `include_markdown_description=true`
  // must be set on the list request or this field is absent.
  const body = task.markdown_description ?? task.description ?? null;
  return {
    tenantId: ctx.tenantId,
    clickupTaskId: task.id,
    title: task.name,
    createdAt: task.date_created ? new Date(Number(task.date_created)).toISOString() : null,
    detail: parseWishlistBody(body),
  };
}
