-- ============================================================================
-- 0027  Wishlist items carry the parsed request detail + one-open-cycle guard
-- ----------------------------------------------------------------------------
-- PART 1 — the request detail, from ClickUp
--
-- Synced wishlist rows have only ever had a title (see 0020): the intake form
-- writes the whole request into the ClickUp task's `markdown_description`, and
-- docs/database/portal.md recorded that parsing it "wasn't worth the fragility".
-- It is now — the wishlist board needs to show what a request is actually about,
-- otherwise nobody can vote on it meaningfully.
--
-- The body follows a stable form layout (verified across all 14 live tasks on
-- list 901218207431 on 2026-08-07):
--   ## <title>
--   **OS Pillar:** | **Capability:** | **Capability :**   <- template drift
--   **Urgency:** ...
--   **Who feels the pain:** ...
--   ### Problem
--   ### Notes from submitter
--   ### Submitter    -> a two-column | Field | Value | table
--   ### Year-review priorities (top 3 …)  <- optional, and appears AFTER Submitter
--
-- Parsed into discrete columns rather than one jsonb, matching what
-- 0023_use_cases_detail.sql did for case studies: the field set is fixed by the
-- form (not user-defined), `submitted_at` needs to be a real timestamptz, and
-- every query in this repo names its columns explicitly.
--
-- `body_md` is the REDACTED verbatim fallback, kept for the same reason as
-- use_cases.body_md: a body the parser doesn't recognise degrades to "shown as
-- written" instead of vanishing. Redacted rather than raw because it reaches a
-- CLIENT surface and the live bodies contain retired taxonomy — 9 of 14 say
-- "OS Pillar: ProductivityOS" or "DataOS".
--
-- There is deliberately NO `capability` column. Translating ProductivityOS /
-- DataOS / 'Needs assignment (submitter chose "Not sure")' into
-- Operations/Intelligence/Enablement would be inventing a mapping — exactly the
-- call 0022 already made for case studies. The parser strips that line entirely.
--
-- The submitter's EMAIL is deliberately not stored. The sync uses it in memory
-- only, to resolve `submitted_by` against this tenant's own profiles; when no
-- profile matches, `submitter_name` carries the display string and no new
-- personal data lands in the table.
--
-- `who_feels_pain` is its own column and does NOT reuse `department` (0018):
-- that means the submitter's own department for portal-native submissions, which
-- is a different question with different answers ("HR Department", "Store
-- managers and merchandising team"). Overloading one column with two meanings is
-- how a wrong label ends up on a client screen.
--
-- `synced_at` is this table's first freshness column (task_cache has had one
-- since 0005). It also makes a future "retire rows deleted in ClickUp" sweep
-- possible. That sweep is NOT built here, on purpose: wishlist_votes.item_id and
-- voting_cycles.winning_item_id reference these rows, and a sweep keyed on
-- `synced_at < run_start` would retire the whole board the first time a ClickUp
-- page fetch failed mid-run.
-- ============================================================================

alter table portal.wishlist_items
  add column if not exists problem           text,
  add column if not exists who_feels_pain    text,
  add column if not exists urgency           text,
  add column if not exists submitter_notes   text,
  add column if not exists submitter_name    text,
  add column if not exists submitter_role    text,
  add column if not exists submitter_company text,
  add column if not exists submitted_at      timestamptz,
  add column if not exists body_md           text,
  add column if not exists synced_at         timestamptz;

-- No new index: portal.wishlist_items (tenant_id) already exists (0005) and the
-- per-tenant row counts are in the tens.

-- ----------------------------------------------------------------------------
-- PART 2 — at most one OPEN voting cycle per tenant
--
-- Nothing enforced this, and three paths open cycles: onboarding step 8
-- (onboarding.repository.ts openFirstVotingCycle), the month-end close's reopen
-- (voting.service.ts), and now the admin open/reopen endpoint. Two open cycles
-- for one tenant makes `order by period_month desc limit 1` arbitrary, so two
-- users' votes on the same board could land in different cycles and neither
-- count would be the truth. The existing unique (tenant_id, period_month) does
-- NOT prevent this — the months differ.
--
-- PRE-FLIGHT (read-only) — this index fails to create if the invariant is
-- already violated, so check before applying:
--   select tenant_id, count(*) from portal.voting_cycles
--    where is_open group by 1 having count(*) > 1;
-- Verified clean before this migration was applied.
--
-- NOTE the paired code change: closeCycle's "open next month" insert must carry
-- `where not exists (… where tenant_id = $1 and is_open)`, or a manually-opened
-- future cycle turns this index into a constraint violation that aborts the
-- whole month-end job. Ship 0027 and that change together.
-- ----------------------------------------------------------------------------

create unique index if not exists voting_cycles_one_open_per_tenant
  on portal.voting_cycles (tenant_id)
  where is_open;
