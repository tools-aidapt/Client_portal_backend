-- 0038  make an in-flight sync distinguishable from a finished one
-- ----------------------------------------------------------------------------
-- `portal.sync_status` was ('success','partial','error') and `startRun()`
-- inserted `status = 'success'` at the START of a run, before anything had
-- actually succeeded. Three different states therefore looked identical in
-- `portal.sync_runs`:
--
--   * a run happening right now
--   * a run whose process died mid-walk
--   * a run that genuinely succeeded
--
-- The only tell was `finished_at is null`, which the crashed and the running
-- case share. That was survivable while the only caller was a cron nobody
-- watched; it is not survivable now that the Sync Console renders these rows
-- as status and has to answer "is a sync running right now" before letting an
-- admin start another one.
--
-- 'running' is added rather than reusing 'partial' because 'partial' already
-- means something real and finished ("completed, but N records were skipped" —
-- e.g. unrouted wishlist tasks), and overloading it would make a legitimately
-- partial result unreadable.
--
-- `triggered_by` separates a manual run from the hourly cron's. Nullable: cron
-- runs have no actor, and every historical row predates the column. It is the
-- same `on delete set null` posture as `core.audit_log` (migration `0012`) —
-- the history of a sync outlives the person who pressed the button.
--
-- Adding the enum value and the column in one file is safe: `add column` does
-- not USE the new label, and Postgres only forbids using a new enum value in
-- the transaction that created it. Runtime code (`syncRepo.startRun`) writes
-- 'running' in a later transaction entirely.
-- ============================================================================

alter type portal.sync_status add value if not exists 'running';

alter table portal.sync_runs
  add column if not exists triggered_by uuid references core.profiles(id) on delete set null;

-- Runs are read newest-first, per entity, on every Console page load.
create index if not exists sync_runs_entity_started_idx
  on portal.sync_runs (entity, started_at desc);
