-- ============================================================================
-- 0049  Show ClickUp "backlog" as "Up next"
-- ----------------------------------------------------------------------------
-- "Backlog" read to clients as work nobody had touched, most visibly on the
-- Onboarding page where every new request starts there. The status itself is
-- unchanged (still upcoming, still synced from ClickUp's "backlog"); only the
-- words a client sees change. Idempotent.
-- ============================================================================

update portal.task_statuses set label = 'Up next' where key = 'backlog' and label is distinct from 'Up next';
