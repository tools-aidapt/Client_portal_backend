-- ============================================================================
-- 0023  Use Cases — structured detail for the expanded card
-- ----------------------------------------------------------------------------
-- The Library cards now open a detail view, which needs more than a one-line
-- `description`. Every case-study task carries a long ClickUp description with a
-- CONSISTENT four-section structure — verified on 38/38 published studies:
--
--   PROBLEM            → what the client is living with today
--   WHAT GETS BUILT    → the solution narrative
--   CONNECTS TO        → newline-separated list of systems/APIs it integrates
--   DEFINITION OF DONE → measurable acceptance criteria
--
-- Storing the parsed sections instead of raw markdown means the UI can lay each
-- one out properly (and "connects to" renders as a real list) without doing
-- text-munging in the browser. `body_md` keeps the original for the cases where
-- parsing finds nothing, so no content is ever lost.
--
-- Also captured: `Business Function` and `Integration Type`, the two remaining
-- populated client-safe fields.
--
-- STILL deliberately NOT synced: `Billed Value ($)` (commercials), `Offer Type`
-- (Retainer/Upfront/SaaS — a pricing model, equally commercial), `Story Points`
-- and `Shortlisted` (internal estimation/triage). None belong on a client surface.
-- ============================================================================

alter table portal.use_cases
  add column if not exists problem            text,
  add column if not exists what_gets_built    text,
  add column if not exists connects_to        text[],
  add column if not exists definition_of_done text,
  add column if not exists business_function  text,
  add column if not exists integration_type   text,
  add column if not exists body_md            text;
