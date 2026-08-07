-- ============================================================================
-- 0021  task_cache records a subtask's parent
-- ----------------------------------------------------------------------------
-- The sync already pulls subtasks (`subtasks=true` on the list endpoint), so
-- subtask cards were landing in task_cache as flat top-level siblings of their
-- own parents — nothing captured ClickUp's `parent` field. Store it so readers
-- can nest or filter.
--
-- Deliberately a plain text column, not an FK to task_cache(clickup_task_id):
-- a parent can sit on a list this tenant doesn't sync (or arrive after its
-- child within the same run), and an FK would reject those rows outright.
-- Null = top-level task.
-- ============================================================================

alter table portal.task_cache
  add column if not exists parent_task_id text;

create index if not exists task_cache_parent_task_id_idx
  on portal.task_cache (parent_task_id)
  where parent_task_id is not null;
