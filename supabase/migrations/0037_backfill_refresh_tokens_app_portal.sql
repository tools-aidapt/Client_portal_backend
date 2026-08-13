-- 0037  backfill every pre-existing refresh-token session as Portal's
-- ----------------------------------------------------------------------------
-- Safe because it is provably true, not an assumption: auth.repository.ts is
-- the ONLY insert into core.refresh_tokens anywhere in this codebase, and no
-- other app has ever pointed at this table. Verified 2026-08-13 — 104 rows,
-- all Portal's.
--
-- Must run AFTER Portal's code starts stamping `app` on new inserts, or in a
-- window short enough that nothing logs in between. Any row written by the
-- new code already carries 'portal'; this only catches the historical ones.
-- Re-running is a no-op — `where app is null` narrows to whatever is still
-- untagged, so it is safe to apply again if a session slipped through the
-- deploy window.
--
-- Separate file from 0036 because Postgres cannot use a new enum value in the
-- transaction that created it; see the note there.
-- ============================================================================

update core.refresh_tokens set app = 'portal' where app is null;
