-- ============================================================================
-- 0045  Manual status override on a whole project
-- ----------------------------------------------------------------------------
-- 0044 let Aidapt staff pin a status on a phase or subtask. A project's status
-- is otherwise derived from its phases (the most advanced open one), and staff
-- also need to set it directly, e.g. to show a project as UAT while ClickUp's
-- phases still lag behind.
--
-- A project is a row in clickup_list_mappings (purpose = 'project'), so the pin
-- lives there. Unlike a task pin, nothing in the sync ever clears it: a project
-- has no ClickUp status of its own to move on from, so it stays until staff
-- choose "Use ClickUp status" in the Hub.
-- ============================================================================

alter table portal.clickup_list_mappings
  add column status_override_key text references portal.task_statuses(key),
  add column status_override_by  uuid references core.profiles(id) on delete set null,
  add column status_override_at  timestamptz;

comment on column portal.clickup_list_mappings.status_override_key is
  'Project status set by hand in the Hub (Aidapt staff only). Wins over the status derived from the phases until cleared. Never written to ClickUp.';
