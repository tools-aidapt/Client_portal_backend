-- ============================================================================
-- 0026  task_cache carries a client-facing title for intake-form submissions
-- ----------------------------------------------------------------------------
-- Tasks on the shared "ORG - Client - Process List" are named by whoever filed
-- them, which in practice means the company itself: Kenafric alone has four
-- real submissions named "Kenafric", "KENAFRIC INDUSTRIES LIMITED", "Kenafric
-- Industries Ltd" and "Kenafric - Operations". On the Onboarding page they read
-- as four copies of the same row — the client cannot tell which request is
-- which.
--
-- The intake form does state what the request is about, on one line of the
-- task's description: "**Project name:** HR Recruitment Solution — …". The sync
-- extracts THAT LINE ONLY and stores it here; the rest of the description is
-- never read into the portal. Raw ClickUp prose is internal by default (the
-- same reason `wishlist_items.description` stays null for synced rows), so this
-- column holds one deliberately-chosen, client-safe string and nothing else.
--
-- Nullable, and null is the normal case: every task outside the intake form —
-- and any submission filed before the form templated its description — simply
-- has no project name to show, and the read falls back to `name`.
-- ============================================================================

alter table portal.task_cache
  add column if not exists display_title text;
