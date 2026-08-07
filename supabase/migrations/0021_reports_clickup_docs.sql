-- ============================================================================
-- 0021  Reports can now sync from a ClickUp Doc
-- ----------------------------------------------------------------------------
-- The real source for bi-weekly client reports is the "Project Updates" section
-- of each client's Project Pack Doc (e.g. "KEN - RET - DOS - Project Pack",
-- doc 8ckbtec-180492), not a task list — one Doc page per report. Nothing in
-- portal.reports could key a row back to its page, so the sync had no way to be
-- idempotent. `clickup_page_id` is that key; `clickup_doc_id` keeps the parent
-- Doc for traceability (and to rebuild the ClickUp URL).
--
-- Partial unique index (same idiom as 0020): portal-native reports created via
-- POST /admin/reports leave both null and never collide with synced rows.
-- ============================================================================

alter table portal.reports
  add column clickup_doc_id  text,
  add column clickup_page_id text;

create unique index reports_clickup_page_id_key
  on portal.reports (clickup_page_id)
  where clickup_page_id is not null;
