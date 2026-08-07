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
  whatGetsBuilt: string | null;
  connectsTo: string[] | null;
  definitionOfDone: string | null;
  bodyMd: string | null;
  sourceListName: string;
  clickupTaskId: string;
  isPublished: boolean;
}

/**
 * Split a case-study description into its four canonical sections. Every study
 * in the library follows the same ALL-CAPS heading layout:
 *
 *   PROBLEM / WHAT GETS BUILT / CONNECTS TO / DEFINITION OF DONE
 *
 * Headings are matched on their own line so prose that happens to contain the
 * words is not mistaken for a heading. Anything that doesn't match simply comes
 * back null and the caller keeps the raw text in `body_md`, so an unparseable
 * description degrades to "shown verbatim" rather than being dropped.
 */
export function parseCaseStudySections(description: string | null | undefined): {
  problem: string | null;
  whatGetsBuilt: string | null;
  connectsTo: string[] | null;
  definitionOfDone: string | null;
} {
  const text = (description ?? '').replace(/\r\n/g, '\n');
  const empty = { problem: null, whatGetsBuilt: null, connectsTo: null, definitionOfDone: null };
  if (!text.trim()) return empty;

  const HEADINGS = [
    ['problem', 'PROBLEM'],
    ['whatGetsBuilt', 'WHAT GETS BUILT'],
    ['connectsTo', 'CONNECTS TO'],
    ['definitionOfDone', 'DEFINITION OF DONE'],
  ] as const;

  // Locate each heading on its own line, then slice up to the next one found.
  const found = HEADINGS.map(([key, label]) => {
    const m = new RegExp(`^\\s*${label}\\s*$`, 'm').exec(text);
    return { key, index: m ? m.index : -1, length: m ? m[0].length : 0 };
  })
    .filter((h) => h.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (found.length === 0) return empty;

  const out: Record<string, string> = {};
  found.forEach((h, i) => {
    const start = h.index + h.length;
    const end = i + 1 < found.length ? found[i + 1]!.index : text.length;
    out[h.key] = text.slice(start, end).trim();
  });

  // "CONNECTS TO" is a newline-separated list of systems, not prose.
  const connects = out.connectsTo
    ? out.connectsTo
        .split('\n')
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean)
    : [];

  return {
    problem: out.problem || null,
    whatGetsBuilt: out.whatGetsBuilt || null,
    connectsTo: connects.length ? connects : null,
    definitionOfDone: out.definitionOfDone || null,
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
 * Map a case-study task to a use_cases row.
 *
 * The publish gate is `Confidentiality Level = 'Public'` — an EXPLICIT
 * classification. Unset (558 of 598 tasks) is treated as not public: this is
 * internal reference material, so an unclassified study is withheld rather than
 * shown. Callers filter on `isPublished`; nothing else decides visibility.
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
    isPublished: confidentiality === 'Public',
  };
}

/** 'Snowflake - Case Studies' -> 'Snowflake'; used as the library's grouping axis. */
export function shortListName(listName: string): string {
  return listName.replace(/\s*-?\s*Case Studies\s*$/i, '').trim() || listName;
}
