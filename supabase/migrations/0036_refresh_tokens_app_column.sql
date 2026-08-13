-- 0036  tag refresh-token sessions with the app that issued them
-- ----------------------------------------------------------------------------
-- core.refresh_tokens has only ever been written by the Portal, so no row has
-- needed to say which app it belongs to. Support Desk and LMS are about to
-- start writing into the same table, at which point "revoke everything for
-- this user" stops being answerable without knowing whose session each row is.
--
-- `core.app_type` (0033) already carries 'lms' and 'support_desk' — it was
-- built for core.app_access, where Portal is deliberately NOT a row (having a
-- core.profiles row at all is what lets you attempt a Portal login). A session
-- is a different question from access, and every session has an issuer, so
-- 'portal' is a real value here.
--
-- The column stays NULLABLE on purpose. Making it `not null` would need a
-- default, and a default is exactly the wrong thing on a column whose whole
-- job is to record which of three apps wrote the row — a mis-defaulted LMS
-- session silently reading as Portal's is worse than a null. Portal's own
-- inserts always set it explicitly (auth.repository.ts).
--
-- Split across 0036/0037 because Postgres forbids USING a new enum value in
-- the same transaction that adds it, and the migration runner wraps each file
-- in its own transaction. 0036 adds the value and the column (neither uses the
-- label); 0037 backfills.
-- ============================================================================

alter type core.app_type add value if not exists 'portal';

alter table core.refresh_tokens add column if not exists app core.app_type;
