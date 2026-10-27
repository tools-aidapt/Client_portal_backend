-- ============================================================================
-- 0043  Wishlist items archived in ClickUp leave the board
-- ----------------------------------------------------------------------------
-- The wishlist sync only ever upserted, so a request archived in ClickUp stayed
-- on the client's board and in every count, voteable, forever. ClickUp's list
-- endpoint leaves archived tasks out, so "no longer returned" is the signal.
--
-- Marked, not deleted: wishlist_votes cascade on delete (a request's vote
-- history would vanish) and voting_cycles.winning_item_id has no cascade at all
-- (a past winner could not be deleted). Past cycles keep showing their winner;
-- only the live board, the vote and winner queries, and the counts skip it.
--
-- Null = live. The sync sets it when the task goes missing from the list and
-- clears it if the task comes back (unarchived in ClickUp).
-- ============================================================================

alter table portal.wishlist_items
  add column if not exists archived_at timestamptz;

create index if not exists wishlist_items_live_tenant_idx
  on portal.wishlist_items (tenant_id)
  where archived_at is null;
