-- ============================================================================
-- 0020  Wishlist items can now sync from ClickUp (ORG - Client - Wishlist)
-- ----------------------------------------------------------------------------
-- `clickup_task_id` already existed but was unused (only portal-native
-- submission wrote here). Adding a partial unique index lets the sync upsert
-- by that id without colliding with portal-native rows, which leave it null.
-- ============================================================================

create unique index wishlist_items_clickup_task_id_key
  on portal.wishlist_items (clickup_task_id)
  where clickup_task_id is not null;
