-- ============================================================================
-- 0022  Use Cases — reconcile with the real ClickUp source
-- ----------------------------------------------------------------------------
-- 0021 was written before the source folder was readable (the service account
-- was denied on it). Access to folder 90129732418 "Case Study Library" has now
-- been granted, and inspecting all 598 tasks across its 5 populated lists
-- changes three things:
--
-- 1. `capability` HAS NO SOURCE. Both candidate fields are 100% empty on this
--    corpus — `OS Pillar` unset on 598/598, `Department` unset on 598/598. The
--    only populated taxonomy is `Use Case Category` (16 values like "Finance &
--    Billing", "Compliance & Risk", "Reporting"), which is a business-function
--    taxonomy, NOT Operations/Intelligence/Enablement. Collapsing 16 categories
--    into 3 capabilities would be inventing a mapping nobody agreed to, so
--    `capability` becomes NULLABLE and is left null by the sync. Grouping the
--    Library by capability needs either someone to populate `OS Pillar` in
--    ClickUp, or an agreed category->capability mapping. Until then the real
--    axes below are what's available.
--
-- 2. The populated fields worth storing are `Short Description` (584/598),
--    `Use Case Category` (263/598), `Niche` (industry), `Build Type` (40/598),
--    and which list a study came from — the library is organised by tool
--    (Automation / Wati / ClickUp / Snowflake / Sigma), which is a real and
--    useful grouping axis given capability is unavailable.
--
-- 3. `Confidentiality Level` is the publish gate: only **40 of 598** are marked
--    'Public'; 558 are UNSET. Unset is treated as NOT public — this is internal
--    reference material and an unclassified study must never reach a client.
--    'Public' is an explicit human classification meaning "shown externally",
--    so it maps to is_published = true (there is no admin UI to flip 40 rows).
--
-- NOT synced, deliberately: `Billed Value ($)` (populated on 162 tasks).
-- Commercials are confidential and must not reach a client-facing surface.
-- ============================================================================

alter table portal.use_cases
  alter column capability drop not null;

alter table portal.use_cases
  add column if not exists category         text,  -- ClickUp "Use Case Category"
  add column if not exists niche            text,  -- ClickUp "Niche" (industry)
  add column if not exists source_list_name text;  -- 'Automation'|'Wati'|'ClickUp'|'Snowflake'|'Sigma'

-- Library reads filter on published and group by the axes that actually have
-- data. The 0021 index assumed capability was always present.
drop index if exists portal.use_cases_published_idx;

create index if not exists use_cases_published_idx
  on portal.use_cases (source_list_name, category, sort_order)
  where is_published = true;
