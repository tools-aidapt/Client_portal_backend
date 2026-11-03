-- ============================================================================
-- 0050  Let Aidapt staff take a task out of the client's view
-- ----------------------------------------------------------------------------
-- A project list sometimes carries a follow-up idea as an extra top-level task
-- (TCC's Matter Intake and Licenses lists each gained one after all seven
-- delivery phases were signed off). The Hub counts it as an unstarted phase, so
-- a delivered project reads 7/8 and In progress.
--
-- `client_visible` can't be used to hide it: the sync rewrites it from the
-- project's visibility on every run. This flag is Hub-owned and never written
-- by the sync; the upsert ANDs it into client_visible, so a hidden task stays
-- hidden. The task itself is untouched in ClickUp. Idempotent.
-- ============================================================================

alter table portal.task_cache
  add column if not exists hidden_from_client boolean not null default false;

comment on column portal.task_cache.hidden_from_client is
  'Set by Aidapt staff: keeps the task (and, by convention, its subtasks) out of every client-facing read across syncs. Not synced from ClickUp.';
