-- ============================================================================
-- 0048  Wishlist: per-client "members can vote" switch
-- ----------------------------------------------------------------------------
-- Until now only a client's admins could vote; plain members read the board.
-- This adds a small portal-owned settings row per tenant. Aidapt staff turn
-- `members_can_vote` on for a client; default OFF, and a tenant with no row is
-- treated as OFF by the API.
--
-- updated_by is a soft reference (no FK) so deleting a staff profile never
-- blocks or rewrites settings history.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create table if not exists portal.wishlist_settings (
  tenant_id         uuid primary key references core.tenants(id) on delete cascade,
  members_can_vote  boolean not null default false,
  updated_by        uuid null,
  updated_at        timestamptz not null default now()
);
