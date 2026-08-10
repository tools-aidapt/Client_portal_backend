import type { ClickUpCustomField, ClickUpTask } from '@infra/clickup/client.js';

/**
 * Custom-field IDs on the "Case Study Library" folder (90129732418). Matched by
 * id, not name, for the same reason as `mapper.ts`: a rename must not silently
 * break the sync.
 *
 * `billedValue` is listed ONLY to document that it is deliberately never read —
 * it holds commercial figures, which must not reach a client-facing surface.
 */
export const CASE_FIELD = {
  shortDescription: 'Short Description',
  confidentiality: 'fbb9c816-fabb-487a-8c62-83c18be6c77c',
  useCaseCategory: '58d2d269-91f7-469f-9db0-1914ed11671a',
  niche: '75a310dd-e3d7-4228-9602-b8af12d9db85',
  buildType: 'a6a68ef6-c368-421c-ae46-daec59606358',
  businessFunction: '116ec8e2-4051-4110-a6ce-cde0b73185ad',
  integrationType: '5bd129d7-66d3-46e5-b2e5-b94c15ef4803',
  // INTENTIONALLY NOT SYNCED — none of these belong on a client surface:
  //   'Billed Value ($)' (currency)      — commercials
  //   'Offer Type' (Retainer/Upfront/…)  — pricing model, equally commercial
  //   'Story Points', 'Shortlisted'      — internal estimation / triage
} as const;

/** Normalized row ready to upsert into portal.use_cases. */
export interface UseCaseUpsert {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  niche: string | null;
  buildType: string | null;
  businessFunction: string | null;
  integrationType: string | null;
  problem: string | null;
  solution: string | null;
  connectsTo: string[] | null;
  impact: string | null;
  bodyMd: string | null;
  sourceListName: string;
  clickupTaskId: string;
  isPublished: boolean;
}

type SectionField = 'problem' | 'solution' | 'impact' | 'connectsTo';

/**
 * Heading -> section, keyed by the lowercased heading with any trailing colon
 * stripped. The five library lists were authored by different people and use
 * three different conventions, so the same section arrives under several names:
 *
 *   Automation + Wati   PROBLEM / WHAT GETS BUILT / DEFINITION OF DONE
 *   ClickUp             Problem: / Solution: / Success Criteria:
 *   Snowflake           Problem / Solution / Success Criteria
 *   Sigma               (no problem) / Purpose / Success Criteria
 *
 * Sigma studies are BI workbooks rather than automations — they describe what a
 * dashboard is for instead of a problem narrative, so `Purpose` is their
 * closest equivalent to Solution and most have no Problem at all.
 */
const HEADING_TO_FIELD = new Map<string, SectionField>([
  ['problem', 'problem'],
  ['what gets built', 'solution'],
  ['solution', 'solution'],
  ['purpose', 'solution'],
  ['definition of done', 'impact'],
  ['success criteria', 'impact'],
  ['connects to', 'connectsTo'],
]);

/**
 * Headings we don't surface but MUST recognise, because a heading is what ends
 * the previous section. Without these, "Success Criteria" would swallow
 * "Estimated Build Time", "MEA Context" and everything after it.
 */
const BOUNDARY_HEADINGS = new Set([
  'integration',
  'integrations',
  'snowflake features used',
  'sigma features used',
  'data sources',
  'data model',
  'implementation phases',
  'mea context',
  'estimated build time',
  'key views & metrics',
  'key views and metrics',
  'interactivity & governance',
  'interactivity and governance',
]);

/** A standalone short line reads as a heading; a sentence does not. */
function headingKey(line: string): string | null {
  const s = line.trim().replace(/:$/, '');
  if (!s || s.length > 40 || !/^[A-Za-z]/.test(s)) return null;
  if (s.split(/\s+/).length > 5) return null;
  return s.toLowerCase();
}

/**
 * `Problem: Banks in MEA spend…` — heading and body on ONE line. Common in the
 * studies whose newlines arrive escaped, where there is no separate heading line
 * to find. Matches a known label followed by a colon, and returns the label plus
 * whatever followed it on that line.
 */
const INLINE_HEADING = new RegExp(
  `^\\s*(${[...HEADING_TO_FIELD.keys(), ...BOUNDARY_HEADINGS]
    .sort((a, b) => b.length - a.length) // longest first, so "connects to" wins over "connects"
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\s*:\\s*(.*)$`,
  'i',
);

/**
 * Split a case-study description into the three client-facing sections
 * (Problem / Solution / Impact) plus the integration list.
 *
 * Line-based rather than regex-per-label: with three heading conventions across
 * the library, walking the lines and looking each one up is both shorter and the
 * only way to treat an unsurfaced heading as a section boundary.
 *
 * The FIRST occurrence of a section wins — a few Sigma studies carry both
 * `Purpose` and `Solution`, and the earlier one is the summary.
 *
 * Anything unrecognised comes back null and the caller keeps the raw text in
 * `body_md`, so an unparseable description degrades to "shown verbatim".
 */
export function parseCaseStudySections(description: string | null | undefined): {
  problem: string | null;
  solution: string | null;
  impact: string | null;
  connectsTo: string[] | null;
} {
  // Some ClickUp descriptions arrive with ESCAPED newlines — the literal two
  // characters `\` `n` instead of a line break — which collapses the whole body
  // into one line and defeats heading detection entirely (8 studies). Unescape
  // before splitting; a real backslash-n in prose doesn't occur here.
  const text = (description ?? '').replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n');
  const empty = { problem: null, solution: null, impact: null, connectsTo: null };
  if (!text.trim()) return empty;

  const buckets = new Map<SectionField, string[]>();
  let current: SectionField | null = null;

  // Opening a section: first occurrence wins, and a repeat heading still closes
  // whatever was being collected.
  const open = (field: SectionField): SectionField | null =>
    buckets.has(field) ? null : (buckets.set(field, []), field);

  for (const line of text.split('\n')) {
    const inline = INLINE_HEADING.exec(line);
    if (inline) {
      const key = inline[1]!.toLowerCase();
      const field = HEADING_TO_FIELD.get(key);
      current = field ? open(field) : null;
      const rest = inline[2]!.trim();
      if (current && rest) buckets.get(current)!.push(rest);
      continue;
    }

    const key = headingKey(line);
    if (key !== null) {
      const field = HEADING_TO_FIELD.get(key);
      if (field) {
        current = open(field);
        continue;
      }
      if (BOUNDARY_HEADINGS.has(key)) {
        current = null;
        continue;
      }
      // Not a known heading — fall through and treat it as content.
    }
    if (current) buckets.get(current)!.push(line);
  }

  const textOf = (field: SectionField): string | null => {
    const joined = (buckets.get(field) ?? []).join('\n').trim();
    return joined || null;
  };

  // "Connects to" is a newline-separated list of systems, not prose.
  const connects = (buckets.get('connectsTo') ?? [])
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  return {
    problem: textOf('problem'),
    solution: textOf('solution'),
    impact: textOf('impact'),
    connectsTo: connects.length ? connects : null,
  };
}

function fieldById(task: ClickUpTask, id: string): ClickUpCustomField | undefined {
  return task.custom_fields?.find((f) => f.id === id);
}

function fieldByName(task: ClickUpTask, name: string): ClickUpCustomField | undefined {
  return task.custom_fields?.find((f) => f.name === name);
}

/** Resolve a drop_down/labels field's selected value(s) to option name(s). */
function optionName(field: ClickUpCustomField | undefined): string | null {
  if (!field || field.value == null || field.value === '') return null;
  const options = field.type_config?.options ?? [];
  const pick = (v: unknown): string | null => {
    const match =
      options.find((o) => o.id === v) ??
      options.find((o) => typeof v === 'number' && o.orderindex === v) ??
      options.find((o) => String(o.orderindex) === String(v));
    return match?.name ?? match?.label ?? (typeof v === 'string' ? v : null);
  };
  const value = field.value;
  if (Array.isArray(value)) {
    const names = value.map(pick).filter((x): x is string => Boolean(x));
    return names.length ? names.join(', ') : null;
  }
  return pick(value);
}

function textValue(field: ClickUpCustomField | undefined): string | null {
  if (!field || field.value == null) return null;
  const s = String(field.value).trim();
  return s === '' ? null : s;
}

/**
 * Values of `Confidentiality Level` that keep a study OUT of the Portal.
 * Anything else — including unset — is publishable.
 */
const WITHHELD_CONFIDENTIALITY = new Set(['NDA-required', 'Internal-only']);

/**
 * Markers the library's authors put in a LEADING bracket tag to flag a task as
 * not-real content: `[ARCHIVE] …`, `[DUPLICATE - DELETE] … superseded by task 09`.
 * 18 such tasks exist, and once publishing became opt-out they would have gone
 * straight onto the client's page — "[DUPLICATE - DELETE]" is not a use case.
 *
 * Only a leading bracket counts, so a study that merely discusses archiving is
 * unaffected.
 */
const HOUSEKEEPING_MARKERS = ['ARCHIVE', 'DUPLICATE', 'DELETE', 'OBSOLETE', 'SUPERSEDED', 'WIP', 'DRAFT'];

function isHousekeepingTitle(name: string): boolean {
  const tag = /^\s*\[([^\]]{1,40})\]/.exec(name);
  if (!tag) return false;
  const inner = tag[1]!.toUpperCase();
  return HOUSEKEEPING_MARKERS.some((m) => inner.includes(m));
}

/**
 * Map a case-study task to a use_cases row.
 *
 * Publishing is OPT-OUT: a study is shown unless `Confidentiality Level` is
 * explicitly `NDA-required` or `Internal-only`.
 *
 * This was originally opt-IN (only `Public` shown), which surfaced 40 of 598
 * because the field is blank on 558 and four of the five lists had no `Public`
 * entry at all. That default was changed on request — the whole library is
 * intended to be client-facing. The explicit values are still honoured, so
 * marking a single study `Internal-only` in ClickUp withdraws it on the next
 * sync; that is now the mechanism for hiding something, rather than the default.
 *
 * Commercial fields are never synced regardless of this flag (see CASE_FIELD).
 */
export function mapCaseStudyTask(task: ClickUpTask, sourceListName: string): UseCaseUpsert {
  const confidentiality = optionName(fieldById(task, CASE_FIELD.confidentiality));
  const body = typeof task.description === 'string' ? task.description.trim() : '';
  const sections = parseCaseStudySections(body);

  return {
    slug: task.id, // ClickUp task id is already a stable, unique public handle
    name: task.name,
    description: textValue(fieldByName(task, CASE_FIELD.shortDescription)),
    category: optionName(fieldById(task, CASE_FIELD.useCaseCategory)),
    niche: optionName(fieldById(task, CASE_FIELD.niche)),
    buildType: optionName(fieldById(task, CASE_FIELD.buildType)),
    businessFunction: optionName(fieldById(task, CASE_FIELD.businessFunction)),
    integrationType: optionName(fieldById(task, CASE_FIELD.integrationType)),
    ...sections,
    bodyMd: body || null,
    sourceListName,
    clickupTaskId: task.id,
    isPublished:
      !(confidentiality !== null && WITHHELD_CONFIDENTIALITY.has(confidentiality)) &&
      !isHousekeepingTitle(task.name),
  };
}

/** 'Snowflake - Case Studies' -> 'Snowflake'; used as the library's grouping axis. */
export function shortListName(listName: string): string {
  return listName.replace(/\s*-?\s*Case Studies\s*$/i, '').trim() || listName;
}
