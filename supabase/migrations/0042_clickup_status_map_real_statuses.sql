-- ============================================================================
-- 0042  Add every real ClickUp status to the global status map
-- ----------------------------------------------------------------------------
-- The global seed in 0011 was written from a generic ClickUp vocabulary ('open',
-- 'planned', 'in review', 'review', 'done', 'closed'). The Aidapt workspace does
-- not use most of those, and it DOES use four the map never knew about.
--
-- An unmapped status stores `task_cache.bucket = null`, and the Projects page
-- renders `phase.bucket ?? 'upcoming'` — so every task in one of these statuses
-- has been telling clients "To be planned". At the time of writing that was 46
-- tasks (43 client-visible) across all five tenants, including phases actively
-- in review:
--
--   allied-bank        planning          18
--   allied-bank        in client review  11
--   trolley            in client review   3
--   jewelfx            internal review    3
--   jewelfx            in client review   2
--   kenafric           in client review   2
--   kenafric           internal review    2
--   allied-bank        internal review    2
--   kenafric           planning           1
--   tile-carpet-centre in client review   1
--   kenafric           ready to develop   1
--
-- The four rows below are every status present in the Delivery (90127425952) and
-- Sprint (90127516104) spaces that was missing, enumerated from the ClickUp API
-- rather than guessed. Each is kept as its own row — they are NOT collapsed into
-- one another — so `status_raw` stays the thing clients read and `bucket` is only
-- the internal roll-up that feeds phase/task counts.
--
-- Bucket choice: 'internal review' and 'in client review' are typed `done` in
-- ClickUp, but neither means the work is signed off, so both roll up as
-- in_progress. Only 'complete' (type `closed`) counts as delivered — the portal
-- must never tell a client something shipped before it did.
--
-- Global rows (tenant_id is null) are inherited by every tenant, including ones
-- onboarded before this migration, because getStatusMap() merges globals with
-- per-tenant rows. Tenant overrides win (fixed in the same change; the merge
-- ordering was inverted and globals were silently overriding tenant rows).
-- ============================================================================

insert into portal.clickup_status_map (tenant_id, raw_status, bucket, sort_order) values
  (null, 'planning',         'upcoming',    14),
  (null, 'ready to develop', 'upcoming',    15),
  (null, 'internal review',  'in_progress', 24),
  (null, 'in client review', 'in_progress', 25)
on conflict (tenant_id, raw_status) do nothing;
