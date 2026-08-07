-- ============================================================================
-- 0030  Retire the bi-weekly reports, enforce one-Doc-one-report
-- ----------------------------------------------------------------------------
-- Removes the nine "Report N: Bi-Monthly Status Report" rows synced from the
-- ClickUp Doc 8ckbtec-180492 ("KEN - RET - DOS - Project Pack"). That series is
-- superseded by the monthly per-client Docs wired up in 0029.
--
-- This runs BEFORE the new sync rather than after it, which is not the safer
-- order but is the only possible one: all nine rows carry the SAME
-- `clickup_doc_id`, so the unique index that makes the new identity model work
-- cannot exist until they are gone. The delete is narrowly scoped to that one
-- doc id, and the irreplaceable data (one client pulse) is copied out first.
--
-- Pre-flight, recorded 2026-08-07:
--   select count(*) from portal.reports where clickup_doc_id='8ckbtec-180492';  -> 9
--   sprint_pulse rows on those reports                                          -> 1 (score 2, no comment)
--   core.notifications where type='report_published'                            -> 1
-- ============================================================================

-- 1. Preserve the client feedback. portal.sprint_pulse cascades on the delete
--    below, and a real MemberPro score is not reproducible.
create table if not exists portal.sprint_pulse_archive_0030 as
select p.*, now() as archived_at
  from portal.sprint_pulse p
  join portal.reports r on r.id = p.report_id
 where r.clickup_doc_id = '8ckbtec-180492';

-- 2. core.notifications.link_url is free text with NO foreign key, so
--    'report_published' rows would survive the delete as permanent
--    /reports/<dead-uuid> 404s in the client's activity panel.
--    MUST run before step 3 — the link is built from the report id.
delete from core.notifications n
 where n.type = 'report_published'
   and n.link_url in (
     select '/reports/' || r.id::text
       from portal.reports r
      where r.clickup_doc_id = '8ckbtec-180492');

-- 3. The nine bi-weekly rows.
delete from portal.reports where clickup_doc_id = '8ckbtec-180492';

-- 4. Now enforceable: one ClickUp Doc yields exactly one report. Keying the
--    upsert on the root PAGE id instead would insert a second report whenever
--    someone deletes and recreates a Doc's root page (page id changes, doc id
--    does not). This is the conflict target the sync's upsert relies on.
create unique index reports_clickup_doc_id_key
  on portal.reports (clickup_doc_id)
  where clickup_doc_id is not null;
