-- ============================================================================
-- 0013  Per-project (ClickUp list) portal visibility
-- ----------------------------------------------------------------------------
-- In the Delivery space a folder = a client and each list = a project. Admins
-- choose which projects appear in the client's Portal. We reuse
-- portal.clickup_list_mappings (purpose = 'project') and add a visibility flag.
--
-- Default is FALSE: a newly discovered project is hidden until an admin enables
-- it, so no client data leaks before it's been reviewed.
-- ============================================================================

alter table portal.clickup_list_mappings
  add column if not exists client_visible boolean not null default false;

-- Fast lookup of a tenant's visible projects.
create index if not exists clickup_list_mappings_visible_idx
  on portal.clickup_list_mappings (tenant_id, purpose)
  where client_visible = true;
