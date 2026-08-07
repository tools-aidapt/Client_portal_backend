import { useCasesRepo, type LibraryQuery } from './usecases.repository.js';

/** Title-case values the frontend's `Capability` type expects. */
export type Capability = 'Operations' | 'Intelligence' | 'Enablement';

const CAPABILITY_LABEL: Record<string, Capability> = {
  operations: 'Operations',
  intelligence: 'Intelligence',
  enablement: 'Enablement',
};

/**
 * Turn a user's free text into a safe tsquery with prefix matching on the last
 * word, so search works as they type ("insur" finds Insurance).
 *
 * The input is NOT interpolated raw: `to_tsquery` parses operators (`&`, `|`,
 * `!`, `:*`, parentheses), so unsanitised text would either throw a syntax error
 * on ordinary punctuation or let a user inject query operators. Every term is
 * therefore stripped to alphanumerics and joined with `&` ourselves.
 *
 * Returns null when there's nothing usable to search on, which makes the caller
 * fall back to plain browsing rather than matching zero rows.
 */
export function toTsQuery(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const terms = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // Single characters match almost everything and just add noise, unless
    // that's all the user typed.
    .filter((t, _i, arr) => t.length > 1 || arr.length === 1);
  if (terms.length === 0) return null;

  // Prefix-match only the final term: earlier ones are complete words the user
  // has already finished typing.
  return terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' & ');
}

/**
 * The Use Cases page: the shared library of automations Aidapt can build.
 *
 * This is NOT the client's own delivery work — that lives on `/projects`.
 *
 * `capability` is null on every synced study (the ClickUp source has no
 * capability field), so `category` / `niche` / `build_type` are the axes the
 * page searches, filters and facets on.
 */
export const useCasesService = {
  async list(params: {
    q?: string;
    niche?: string;
    category?: string;
    buildType?: string;
  }) {
    const query: LibraryQuery = {
      tsQuery: toTsQuery(params.q),
      niche: params.niche ?? null,
      category: params.category ?? null,
      buildType: params.buildType ?? null,
    };

    const [rows, facets, total] = await Promise.all([
      useCasesRepo.library(query),
      useCasesRepo.facets(query.tsQuery),
      useCasesRepo.publishedTotal(),
    ]);

    return {
      /** Every published study, ignoring search/filters — the "of N" denominator. */
      total,
      /** How many matched the current search + filters. */
      matched: rows.length,
      /** Echoed back so the client can tell an ignored query from an applied one. */
      query: {
        q: params.q ?? null,
        niche: query.niche,
        category: query.category,
        build_type: query.buildType,
        /** False when `q` was given but held nothing searchable. */
        search_applied: query.tsQuery !== null,
      },
      facets,
      library: rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        capability: r.capability ? (CAPABILITY_LABEL[r.capability] ?? null) : null,
        description: r.description,
        build_type: r.build_type,
        category: r.category,
        niche: r.niche,
        source: r.source_list_name,
        snippet: r.snippet,
      })),
    };
  },

  /** One library study with its full narrative. Null when unknown/unpublished. */
  async detail(slug: string) {
    const r = await useCasesRepo.libraryDetail(slug);
    if (!r) return null;
    return {
      slug: r.slug,
      name: r.name,
      capability: r.capability ? (CAPABILITY_LABEL[r.capability] ?? null) : null,
      description: r.description,
      build_type: r.build_type,
      category: r.category,
      niche: r.niche,
      source: r.source_list_name,
      business_function: r.business_function,
      integration_type: r.integration_type,
      problem: r.problem,
      what_gets_built: r.what_gets_built,
      connects_to: r.connects_to ?? [],
      definition_of_done: r.definition_of_done,
      // Only useful when the structured sections are absent; the UI falls back to it.
      body_md: r.problem || r.what_gets_built ? null : r.body_md,
    };
  },
};
