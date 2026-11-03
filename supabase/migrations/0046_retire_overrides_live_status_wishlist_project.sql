-- ============================================================================
-- 0046  Retire manual status overrides and 'live'; link wishlist items to projects
-- ----------------------------------------------------------------------------
-- 1. Status now comes only from ClickUp. The Hub-side pins added in 0044
--    (task_cache.status_override_*) and 0045 (clickup_list_mappings.status_
--    override_*) are retired: every value is nulled, the columns stay so the
--    migration is reversible and nothing downstream breaks mid-deploy.
-- 2. 'live' collapses into 'complete'. Both were delivered-bucket statuses, so
--    no count changes; the distinction was only ever a label. Every reference
--    (status map, cached tasks) is remapped before the catalogue row is
--    removed, because all three are foreign keys.
-- 3. A wishlist item can point at the project (ClickUp list) that delivered it,
--    so the board can show that project's status and progress.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 'live' -> 'complete'
-- ----------------------------------------------------------------------------

update portal.clickup_status_map set status_key = 'complete' where status_key = 'live';
update portal.task_cache         set status_key = 'complete' where status_key = 'live';
-- Overrides are cleared below, but they reference the catalogue too and must not
-- block the delete.
update portal.task_cache set status_override_key = null where status_override_key = 'live';
update portal.clickup_list_mappings set status_override_key = null where status_override_key = 'live';

delete from portal.task_statuses where key = 'live';

-- ----------------------------------------------------------------------------
-- Overrides retired
-- ----------------------------------------------------------------------------

-- A task pin also rewrote `bucket` to the pinned status's bucket. Put it back to
-- the bucket of the synced status before the pin is cleared, so counts are right
-- straight away rather than after the next sync.
update portal.task_cache tc
   set bucket = s.bucket
  from portal.task_statuses s
 where s.key = tc.status_key
   and tc.status_override_key is not null
   and tc.bucket is distinct from s.bucket;

update portal.task_cache
   set status_override_key = null, status_override_by = null, status_override_at = null
 where status_override_key is not null or status_override_by is not null or status_override_at is not null;

update portal.clickup_list_mappings
   set status_override_key = null, status_override_by = null, status_override_at = null
 where status_override_key is not null or status_override_by is not null or status_override_at is not null;

comment on column portal.task_cache.status_override_key is
  'RETIRED (0046): always null. Status comes only from ClickUp via status_key. Column kept, unused.';
comment on column portal.clickup_list_mappings.status_override_key is
  'RETIRED (0046): always null. A project''s status is derived from its ClickUp phases. Column kept, unused.';

-- ----------------------------------------------------------------------------
-- Wishlist item -> project
-- ----------------------------------------------------------------------------

alter table portal.wishlist_items
  add column if not exists project_list_id text;

-- Composite FK on (tenant_id, clickup_list_id), the mapping's unique key, so an
-- item can only point at a project of its own tenant. SET NULL names only the
-- list column: tenant_id is NOT NULL and must survive a mapping delete.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wishlist_items_project_list_fkey'
  ) then
    alter table portal.wishlist_items
      add constraint wishlist_items_project_list_fkey
      foreign key (tenant_id, project_list_id)
      references portal.clickup_list_mappings (tenant_id, clickup_list_id)
      on delete set null (project_list_id);
  end if;
end $$;

comment on column portal.wishlist_items.project_list_id is
  'ClickUp list id of the project (clickup_list_mappings, purpose = project) this request was delivered through. Set by Aidapt staff; null = not linked.';

create index if not exists wishlist_items_project_list_idx
  on portal.wishlist_items (tenant_id, project_list_id)
  where project_list_id is not null;
