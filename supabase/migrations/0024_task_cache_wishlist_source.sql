-- ============================================================================
-- 0024  task_cache records the wishlist item a process onboarding came from
-- ----------------------------------------------------------------------------
-- Per the product spec, a wishlist item that wins a monthly voting cycle
-- (state = 'prioritised', portal.voting_cycles.winning_item_id) is meant to
-- become a real Process Onboarding submission — the Pod scopes it via the
-- onboarding form and a ClickUp task lands on the shared "ORG - Client -
-- Process List". Nothing recorded that "this onboarding task is the thing that
-- won the vote", so the client could never see the loop close.
--
-- A real FK here (unlike parent_task_id in 0021, which is deliberately loose
-- text): both sides are portal-owned uuids that always exist locally, so the
-- constraint can be enforced. ON DELETE SET NULL — deleting a wishlist item
-- must not take a delivery-cache row with it; the task simply loses its origin.
--
-- Null = this task did not come from the wishlist (the overwhelming majority).
-- Populated by a deliberate admin action, never by the sync: there is no
-- reliable way to match an arbitrary ClickUp task to a wishlist item, and the
-- sync's upsert lists its columns explicitly, so a link set here survives every
-- subsequent re-sync of the same task. See docs/database/portal.md.
-- ============================================================================

alter table portal.task_cache
  add column if not exists source_wishlist_item_id uuid
    references portal.wishlist_items(id) on delete set null;

create index if not exists task_cache_source_wishlist_item_id_idx
  on portal.task_cache (source_wishlist_item_id)
  where source_wishlist_item_id is not null;
