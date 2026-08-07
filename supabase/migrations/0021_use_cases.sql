-- ============================================================================
-- 0021  Use Cases — tenant-agnostic reference library
-- ----------------------------------------------------------------------------
-- Backs the Portal's "Use Cases" page, which is really TWO different things:
--
--   1. "Live automations" — the client's own automations, with status + outcome.
--      This is a re-cut of delivery work that ALREADY lives in
--      `portal.task_cache` (source='delivery') + `portal.clickup_list_mappings`
--      (purpose='project'). It gets NO table here: giving it one would create a
--      second source of truth for the same engagements and a second thing to
--      keep in sync. The read endpoint derives it instead.
--
--   2. "Library" — a catalogue of automations Aidapt can build ("Invoice
--      generation", "Support ticket triage"). It is IDENTICAL for every client:
--      no tenant, no status, no assignees, no dates. That is why it does not
--      fit `task_cache`, where every row is `tenant_id not null` — and why
--      reusing `clickup_list_mappings.purpose` would not work either, since
--      that table is tenant-keyed and would force either a sentinel tenant or
--      one duplicate row per tenant per use case.
--
-- Hence: one small dedicated table with NO tenant_id.
--
-- `capability` is stored lowercase to match every other enum in this schema
-- (portal.task_bucket etc.); the service maps it to the title-case values the
-- frontend's `Capability` type expects. Only the three current capabilities are
-- representable — ClickUp's `OS Pillar`/`Department` fields still carry the
-- retired "AI Operations"/"Cross Department" values, so any future ingest must
-- translate rather than pass through.
--
-- `clickup_task_id` is nullable and unused for now: the intended ClickUp source
-- (folder 90129732418, space 90127425921) is not readable by the sync's service
-- account (`sofi@aidapt.co`) — ClickUp returns INSUFFICIENT_ACCESS on both
-- `can_read` and `can_use_public_api_dev_key`. Rows are therefore curated
-- portal-side until that access is granted. If the source turns out to be
-- ClickUp *Docs* rather than tasks, this column becomes `clickup_doc_id`.
-- ============================================================================

create type portal.capability as enum ('operations', 'intelligence', 'enablement');

create table portal.use_cases (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,          -- stable id for the frontend
  name             text not null,
  capability       portal.capability not null,
  description      text,
  build_type       text,                          -- 'n8n Automation','Dashboard',… (free text: ClickUp's list churns)
  clickup_task_id  text unique,                   -- null until the source folder is readable
  is_published     boolean not null default false,-- hidden until reviewed, same posture as project visibility (0013)
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz
);

-- The only read pattern: published entries, grouped/ordered for the Library.
create index use_cases_published_idx
  on portal.use_cases (capability, sort_order)
  where is_published = true;

-- Migration 0001 grants `anon` SELECT on every portal table (and sets default
-- privileges for later ones), so RLS is mandatory even for non-sensitive data.
-- Published rows are readable by any authenticated user — same posture as
-- portal.sprints (0009), since the library is not tenant data. Unpublished rows
-- are reachable only by the service role, which bypasses RLS. `anon` gets no
-- policy at all, so the blanket grant is neutralized.
alter table portal.use_cases enable row level security;

create policy use_cases_read on portal.use_cases
  for select to authenticated using (is_published);
