-- ============================================================================
-- 0029  Reports become monthly, per client, with per-pillar sections
-- ----------------------------------------------------------------------------
-- The report source changes shape. Until now one ClickUp Doc held the whole
-- bi-weekly series ("KEN - RET - DOS - Project Pack", 8ckbtec-180492) and each
-- child page was a report. The real cadence is monthly: each client has its own
-- "Monthly Progress Reports" FOLDER in Delivery holding one Doc per month, whose
-- root page is the report and whose child pages are the pillar deep-dives
-- (AI Operations / Intelligence / Enablement — clients carry 2 or 3 of them).
--
-- So one report is now one DOC, and the pillar pages become child rows. The
-- 0030 migration removes the old bi-weekly rows once the new sync is proven.
--
-- Why the folder id lives on core.tenants and NOT in portal.clickup_list_mappings:
-- that table's column is `clickup_list_id`, and both `resolveTenantByListId` and
-- `getListPurpose` query it with NO purpose filter. ClickUp folder and list ids
-- are the same numeric shape, so a folder id parked there would start resolving
-- as a list and silently change `syncSpaces` routing. It is also strictly 1:1
-- per tenant — exactly like the `clickup_folder_id` sitting beside it.
-- ============================================================================

alter table core.tenants
  add column if not exists clickup_reports_folder_id text;

create unique index tenants_reports_folder_key
  on core.tenants (clickup_reports_folder_id)
  where clickup_reports_folder_id is not null;

-- `clickup_folder_id` has never had a unique index. Two tenants pointed at one
-- folder is the exact condition behind the 441-task mis-routing recorded in
-- docs/database/portal.md — close it while we are here. (Verified zero
-- duplicates before writing this.)
create unique index tenants_clickup_folder_key
  on core.tenants (clickup_folder_id)
  where clickup_folder_id is not null;

-- A reports folder is a sibling of the client folder, never the same folder.
-- Pasting one into the other would route a client's entire task sync to nothing.
alter table core.tenants
  add constraint tenants_folder_ids_distinct
  check (clickup_reports_folder_id is distinct from clickup_folder_id);

alter table portal.reports
  add column if not exists doc_updated_at timestamptz,  -- ClickUpDoc.date_updated
  add column if not exists synced_at      timestamptz;

-- NOTE: the `reports_clickup_doc_id_key` unique index that makes "one Doc = one
-- report" enforceable lives in 0030, not here. It cannot be created while the
-- nine bi-weekly rows exist, because all nine share the single doc id
-- 8ckbtec-180492 — under the old model a Doc held the whole series. 0030 deletes
-- those rows and then creates the index in the same transaction.

-- Target for the composite FK below, which is what actually stops a section
-- from ever pointing at a report belonging to a different tenant.
alter table portal.reports
  add constraint reports_id_tenant_key unique (id, tenant_id);

-- One row per pillar page of a monthly report.
create table portal.report_sections (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null,
  -- Denormalised so the RLS policy below can be the same one-liner as
  -- `reports_read` rather than an exists(...) subquery. The composite FK keeps
  -- it honest.
  tenant_id        uuid not null,
  clickup_page_id  text not null unique,
  pillar           portal.capability,   -- null when the page is not a known pillar
  pillar_label     text not null,       -- verbatim ClickUp page name, e.g. "AI Operations"
  pillar_owner     text,
  subtitle         text,
  body_md          text,
  committed_count  int,
  delivered_count  int,
  sort_order       int not null default 0,
  synced_at        timestamptz not null default now(),

  constraint report_sections_report_fk
    foreign key (report_id, tenant_id)
    references portal.reports (id, tenant_id) on delete cascade
);

create index report_sections_report_idx on portal.report_sections (report_id, sort_order);

-- REQUIRED, not optional: migration 0001 grants `anon` SELECT by default on
-- every future table in `portal`, so a table with RLS off is world-readable.
-- Mirrors `reports_read` (0009) exactly — reports are a MemberPro capability.
alter table portal.report_sections enable row level security;

create policy report_sections_read on portal.report_sections
  for select using (
    core.is_platform_admin() or core.tenant_role(tenant_id) = 'member_pro'
  );

-- Kenafric's Monthly Progress Reports folder. The other four folders
-- (ABL 901212877810, TRO 901212877735, JFX 901212877721, TCC 901212877707)
-- are set when those clients get tenant rows — only Kenafric exists today.
update core.tenants
   set clickup_reports_folder_id = '901212877607'
 where slug = 'kenafric';
