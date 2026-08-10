import { pool } from '@infra/db/pool.js';

export interface LibraryRow {
  slug: string;
  name: string;
  /** Null for every synced study — the ClickUp source has no capability field. */
  capability: 'operations' | 'intelligence' | 'enablement' | null;
  description: string | null;
  build_type: string | null;
  category: string | null;
  niche: string | null;
  source_list_name: string | null;
  /**
   * Why this row matched, when searching. Match runs are wrapped in `[[…]]`
   * rather than HTML so the client can highlight without rendering markup.
   * Null when no search term was given.
   */
  snippet: string | null;
}

/** A single study with its full narrative, for the expanded card. */
export interface LibraryDetailRow extends Omit<LibraryRow, 'snippet'> {
  business_function: string | null;
  integration_type: string | null;
  problem: string | null;
  solution: string | null;
  connects_to: string[] | null;
  impact: string | null;
  /** Raw ClickUp body — a fallback for studies whose sections didn't parse. */
  body_md: string | null;
}

export interface LibraryQuery {
  /** A ready-to-use tsquery string (built by the service), or null to browse all. */
  tsQuery: string | null;
  niche: string | null;
  category: string | null;
  buildType: string | null;
}

export interface LibraryPage extends LibraryQuery {
  limit: number;
}

export interface FacetCount {
  value: string;
  count: number;
}

/** Highlight delimiters — plain text, so no markup ever reaches the browser. */
const HEADLINE_OPTS = 'StartSel=[[, StopSel=]], MaxWords=28, MinWords=12, ShortWord=3, MaxFragments=1';

/**
 * Build the shared WHERE clause + params for a library query. Returned params
 * are positional starting at $1, so callers append their own after `next`.
 */
function buildFilter(q: LibraryQuery): { where: string; params: unknown[]; next: number } {
  const clauses = ['is_published = true'];
  const params: unknown[] = [];
  if (q.tsQuery) {
    params.push(q.tsQuery);
    clauses.push(`search_vector @@ to_tsquery('english', $${params.length})`);
  }
  if (q.niche) {
    params.push(q.niche);
    clauses.push(`niche = $${params.length}`);
  }
  if (q.category) {
    params.push(q.category);
    clauses.push(`category = $${params.length}`);
  }
  if (q.buildType) {
    params.push(q.buildType);
    clauses.push(`build_type = $${params.length}`);
  }
  return { where: clauses.join(' and '), params, next: params.length + 1 };
}

export const useCasesRepo = {
  /**
   * The tenant-agnostic library, optionally searched and filtered. No tenant
   * filter — this catalogue is identical for every client.
   *
   * Ordering is by search rank when searching (best match first) and
   * alphabetical when browsing, so the list is never arbitrary.
   */
  async library(q: LibraryPage): Promise<LibraryRow[]> {
    const { where, params } = buildFilter(q);

    // `$1` is the tsquery whenever one is present, so it can be reused here.
    const rank = q.tsQuery ? `ts_rank(search_vector, to_tsquery('english', $1))` : null;
    const snippet = q.tsQuery
      ? `ts_headline('english',
           coalesce(description, '') || ' ' || coalesce(problem, ''),
           to_tsquery('english', $1), '${HEADLINE_OPTS}')`
      : 'null::text';

    params.push(q.limit);
    const { rows } = await pool.query<LibraryRow>(
      `select slug, name, capability, description, build_type, category, niche,
              source_list_name, ${snippet} as snippet
         from portal.use_cases
        where ${where}
        order by ${rank ? `${rank} desc,` : ''} name
        limit $${params.length}`,
      params,
    );
    return rows;
  },

  /**
   * How many rows the current search + filters match, ignoring `limit` — the
   * page needs the real total to show "48 of 214" and decide whether there is
   * more to load.
   */
  async libraryCount(q: LibraryQuery): Promise<number> {
    const { where, params } = buildFilter(q);
    const { rows } = await pool.query<{ count: string }>(
      `select count(*) as count from portal.use_cases where ${where}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Counts per filter dimension for the current SEARCH, ignoring the dimension
   * filters themselves. That's deliberate: pills show how the search breaks
   * down and keep stable counts as you toggle between them, instead of options
   * vanishing the moment you pick one.
   */
  async facets(tsQuery: string | null): Promise<{
    niche: FacetCount[];
    category: FacetCount[];
    build_type: FacetCount[];
  }> {
    const { where, params } = buildFilter({ tsQuery, niche: null, category: null, buildType: null });

    const { rows } = await pool.query<{ dimension: string; value: string; count: string }>(
      `with matched as (select niche, category, build_type from portal.use_cases where ${where})
       select 'niche' as dimension, niche as value, count(*) as count
         from matched where niche is not null group by niche
       union all
       select 'category', category, count(*) from matched where category is not null group by category
       union all
       select 'build_type', build_type, count(*) from matched where build_type is not null group by build_type
       order by count desc, value`,
      params,
    );

    const out = {
      niche: [] as FacetCount[],
      category: [] as FacetCount[],
      build_type: [] as FacetCount[],
    };
    for (const r of rows) {
      const bucket = out[r.dimension as keyof typeof out];
      if (bucket) bucket.push({ value: r.value, count: Number(r.count) });
    }
    return out;
  },

  /** Total published studies, ignoring all search/filters — the "of N" denominator. */
  async publishedTotal(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*) as count from portal.use_cases where is_published = true`,
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * One published study by slug, with its full narrative. Unpublished studies
   * are not addressable — the `is_published` filter is the same gate the list
   * uses, so a direct slug guess can't reach withheld content.
   */
  async libraryDetail(slug: string): Promise<LibraryDetailRow | null> {
    const { rows } = await pool.query<LibraryDetailRow>(
      `select slug, name, capability, description, build_type, category, niche,
              source_list_name, business_function, integration_type,
              problem, solution, connects_to, impact, body_md
         from portal.use_cases
        where slug = $1 and is_published = true`,
      [slug],
    );
    return rows[0] ?? null;
  },
};
