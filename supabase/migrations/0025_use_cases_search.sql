-- ============================================================================
-- 0025  Use Cases — full-text search
-- ----------------------------------------------------------------------------
-- The Library is browse-by-filter only, which stops working once a client is
-- after something specific ("freight invoice", "claims fraud"). Client-side
-- string matching wouldn't cover it either: the useful words live in the
-- NARRATIVE (problem / what gets built / connects to), and the list payload
-- deliberately doesn't carry that — so search has to run in Postgres.
--
-- Weights: A name · B short description · C the facet fields · D the narrative.
--
-- Maintained by a TRIGGER, not a generated column. A generated column requires
-- every function in its expression to be IMMUTABLE, and `concat_ws` /
-- `array_to_string` are only STABLE (they can invoke type-output functions), so
-- Postgres rejects them with "generation expression is not immutable". A trigger
-- has no such restriction and still keeps the vector in lockstep with the row,
-- so the sync writes plain columns and never has to refresh a search field.
-- ============================================================================

alter table portal.use_cases
  add column if not exists search_vector tsvector;

create or replace function portal.use_cases_set_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('english',
      concat_ws(' ',
        new.category,
        new.niche,
        new.build_type,
        new.business_function,
        new.integration_type)), 'C') ||
    setweight(to_tsvector('english',
      concat_ws(' ',
        new.problem,
        new.what_gets_built,
        new.definition_of_done,
        array_to_string(coalesce(new.connects_to, '{}'), ' '))), 'D');
  return new;
end;
$$;

drop trigger if exists use_cases_search_vector_tg on portal.use_cases;

create trigger use_cases_search_vector_tg
  before insert or update on portal.use_cases
  for each row execute function portal.use_cases_set_search_vector();

-- Backfill the rows that already exist (the trigger only fires on write).
update portal.use_cases set updated_at = updated_at;

create index if not exists use_cases_search_idx
  on portal.use_cases using gin (search_vector);

-- Filter pills hit these three columns constantly; published-only to match the
-- read path (0022's index covers the unfiltered ordering).
create index if not exists use_cases_facets_idx
  on portal.use_cases (niche, category, build_type)
  where is_published = true;
