-- ============================================================================
-- 0018  Wishlist detail fields
-- ----------------------------------------------------------------------------
-- The wishlist is owned entirely by the Portal (Supabase), not ClickUp. Add the
-- optional reference video URL and the submitter's department so the client
-- wishlist board can show fuller context alongside title/description.
-- ============================================================================

alter table portal.wishlist_items add column if not exists reference_video_url text;
alter table portal.wishlist_items add column if not exists department          text;
