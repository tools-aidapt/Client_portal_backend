-- 0034  fix a real edge-case bug in tenants_folder_ids_distinct
-- ----------------------------------------------------------------------------
-- The original check — clickup_reports_folder_id IS DISTINCT FROM
-- clickup_folder_id — was meant to stop the same ClickUp folder being reused
-- for both purposes. But `IS DISTINCT FROM` treats two NULLs as NOT distinct,
-- so it accidentally also rejected the completely normal case of a brand-new
-- tenant with no ClickUp integration at all yet (both columns null). Only
-- enforce the real rule when both are actually set to something.
-- ============================================================================

alter table core.tenants drop constraint tenants_folder_ids_distinct;

alter table core.tenants add constraint tenants_folder_ids_distinct check (
  clickup_folder_id is null
  or clickup_reports_folder_id is null
  or clickup_reports_folder_id is distinct from clickup_folder_id
);
