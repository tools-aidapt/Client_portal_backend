-- ============================================================================
-- 0047  Project tags (Aidapt-curated) and onboarding request -> project link
-- ----------------------------------------------------------------------------
-- 1. portal.project_tags: a small global vocabulary Aidapt staff attach to a
--    client's projects ("UAT", "Blocked", "Go-live" ...). `tone` reuses the
--    badge tones of portal.task_statuses (0044) so the frontend renders both
--    with the same variants. Clients only read tags; staff write them.
-- 2. portal.project_tag_assignments: which tags a project (tenant + ClickUp
--    list) carries, with at most ONE primary tag per project. The primary tag's
--    tone becomes the project card's accent colour.
-- 3. portal.task_cache.project_list_id: an onboarding request can point at the
--    project that delivers it (same shape as wishlist_items.project_list_id,
--    0046). Set only by an admin action; the sync upsert lists its columns
--    explicitly and never touches this one, so a link survives every re-sync.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tag vocabulary
-- ----------------------------------------------------------------------------

create table if not exists portal.project_tags (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  label       text not null,
  -- Same set as portal.task_statuses.tone (0044).
  tone        text not null check (tone in ('neutral', 'info', 'warning', 'error', 'success', 'teal')),
  sort_order  int not null default 100,
  created_by  uuid null references core.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

insert into portal.project_tags (key, label, tone, sort_order) values
  ('uat',             'UAT',             'teal',    10),
  ('internal-review', 'Internal review', 'warning', 20),
  ('awaiting-client', 'Awaiting client', 'warning', 30),
  ('blocked',         'Blocked',         'error',   40),
  ('on-hold',         'On hold',         'neutral', 50),
  ('priority',        'Priority',        'error',   60),
  ('phase-2',         'Phase 2',         'info',    70),
  ('go-live',         'Go-live',         'success', 80),
  ('support',         'Support',         'neutral', 90)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Assignments
-- ----------------------------------------------------------------------------

create table if not exists portal.project_tag_assignments (
  tenant_id       uuid not null,
  clickup_list_id text not null,
  tag_id          uuid not null references portal.project_tags(id) on delete cascade,
  is_primary      boolean not null default false,
  created_by      uuid null references core.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, clickup_list_id, tag_id),
  -- Composite FK on the mapping's unique key: a tag can only be attached to a
  -- project of its own tenant, and disappears with the mapping.
  foreign key (tenant_id, clickup_list_id)
    references portal.clickup_list_mappings (tenant_id, clickup_list_id)
    on delete cascade
);

-- At most one primary tag per project.
create unique index if not exists project_tag_assignments_one_primary_uidx
  on portal.project_tag_assignments (tenant_id, clickup_list_id)
  where is_primary;

create index if not exists project_tag_assignments_tag_idx
  on portal.project_tag_assignments (tag_id);

-- ----------------------------------------------------------------------------
-- Onboarding request -> project
-- ----------------------------------------------------------------------------

alter table portal.task_cache
  add column if not exists project_list_id text;

-- SET NULL names only the list column: tenant_id is NOT NULL and must survive a
-- mapping delete.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'task_cache_project_list_fkey'
  ) then
    alter table portal.task_cache
      add constraint task_cache_project_list_fkey
      foreign key (tenant_id, project_list_id)
      references portal.clickup_list_mappings (tenant_id, clickup_list_id)
      on delete set null (project_list_id);
  end if;
end $$;

comment on column portal.task_cache.project_list_id is
  'ClickUp list id of the project (clickup_list_mappings, purpose = project) delivering this onboarding request. Set by Aidapt staff; never written by the sync; null = not linked.';

create index if not exists task_cache_project_list_idx
  on portal.task_cache (tenant_id, project_list_id)
  where project_list_id is not null;
