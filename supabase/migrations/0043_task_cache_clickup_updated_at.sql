-- Last edit time in ClickUp (`date_updated`), distinct from synced_at which is
-- when the portal last pulled the task. Null until the next sync backfills it.
alter table portal.task_cache
  add column if not exists clickup_updated_at timestamptz;
