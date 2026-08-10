-- ============================================================================
-- 0026  Use Cases — rename the narrative columns to Problem / Solution / Impact
-- ----------------------------------------------------------------------------
-- The client-facing card now shows exactly three headings, and the columns were
-- named after ONE list's wording (`what_gets_built`, `definition_of_done` — the
-- Automation/Wati convention). Once the whole library is published, the same
-- slots also hold `Solution` / `Purpose` and `Success Criteria` from the
-- ClickUp, Snowflake and Sigma lists, so the old names actively mislead.
--
--   what_gets_built    -> solution   (also holds "Solution", "Purpose")
--   definition_of_done -> impact     (also holds "Success Criteria")
--
-- `problem` and `connects_to` keep their names. `connects_to` is still stored
-- and still searchable; it just isn't one of the three shown headings.
--
-- The search trigger MUST be recreated: its body references the old column names
-- and plpgsql resolves those at execution time, so leaving it alone would break
-- the very next insert or update with "record new has no field what_gets_built".
-- ============================================================================

alter table portal.use_cases rename column what_gets_built to solution;
alter table portal.use_cases rename column definition_of_done to impact;

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
        new.solution,
        new.impact,
        array_to_string(coalesce(new.connects_to, '{}'), ' '))), 'D');
  return new;
end;
$$;

-- Re-fire the trigger so every row's vector is rebuilt from the renamed columns.
update portal.use_cases set updated_at = updated_at;
