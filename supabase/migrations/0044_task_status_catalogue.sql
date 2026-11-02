-- ============================================================================
-- 0044  Task status catalogue + manual status override
-- ----------------------------------------------------------------------------
-- Until now a task's status reached the client only as one of three buckets
-- (upcoming / in_progress / delivered). That roll-up is right for COUNTS and
-- for the badge colour, but wrong as the words a client reads: "internal
-- review" and "in client review" both rolled up to in_progress, so a project
-- sitting in UAT read "In progress" on the Projects page.
--
-- This migration adds the missing layer between ClickUp's raw status and the
-- bucket:
--
--   portal.task_statuses         — the canonical, client-facing catalogue:
--                                  key, label ("UAT"), badge tone, bucket, order
--   clickup_status_map.status_key — raw ClickUp status -> catalogue key
--   task_cache.status_key        — the catalogue key the sync resolved
--   task_cache.status_override_* — a status set by hand in the Hub, which wins
--                                  over the synced one until ClickUp moves on
--
-- `bucket` stays and keeps feeding every count, so nothing downstream breaks;
-- it is simply derived from the effective (override-or-synced) status now.
--
-- The catalogue rows below are every status present in the Delivery
-- (90127425952) and Sprint (90127516104) spaces as of 2026-11-02 (enumerated
-- in 0042 from the ClickUp API, confirmed against task_cache.status_raw),
-- plus the generic ClickUp vocabulary 0011 seeded, folded onto the nearest
-- real status so no existing map row is left without a key.
--
-- Bucket choice is unchanged from 0042: the two review statuses are typed
-- `done` in ClickUp but nothing is signed off, so they stay in_progress. Only
-- complete/live count as delivered.
-- ============================================================================

create table portal.task_statuses (
  key         text primary key,
  label       text not null,
  -- Badge tone, matching the frontend's Badge variants.
  tone        text not null check (tone in ('neutral', 'info', 'warning', 'error', 'success', 'teal')),
  bucket      portal.task_bucket not null,
  sort_order  int not null,
  -- What the status means for the client, shown as help text in the admin picker.
  description text
);

insert into portal.task_statuses (key, label, tone, bucket, sort_order, description) values
  ('to_do',            'To do',            'neutral', 'upcoming',    10, 'Scoped, not yet scheduled'),
  ('backlog',          'Backlog',          'neutral', 'upcoming',    11, 'Captured for a later phase'),
  ('planning',         'Planning',         'neutral', 'upcoming',    14, 'Being planned with the Pod'),
  ('ready_to_develop', 'Ready to develop', 'info',    'upcoming',    15, 'Planned and queued for build'),
  ('in_progress',      'In progress',      'info',    'in_progress', 20, 'Actively being built'),
  ('blocked',          'Blocked',          'error',   'in_progress', 23, 'Waiting on an input or decision'),
  ('internal_review',  'Internal review',  'warning', 'in_progress', 24, 'Aidapt quality review before handover'),
  ('client_review',    'UAT',              'teal',    'in_progress', 25, 'With the client for acceptance testing'),
  ('complete',         'Complete',         'success', 'delivered',   30, 'Signed off and delivered'),
  ('live',             'Live',             'success', 'delivered',   35, 'Delivered and running in production');

-- ----------------------------------------------------------------------------
-- clickup_status_map -> catalogue key
-- ----------------------------------------------------------------------------

-- unique (tenant_id, raw_status) never caught duplicate GLOBAL rows, because in
-- SQL two NULL tenant_ids are not equal. 0042 ran twice somewhere and left two
-- copies of each of its four rows. Collapse them before indexing properly.
delete from portal.clickup_status_map a
 using portal.clickup_status_map b
 where a.tenant_id is null and b.tenant_id is null
   and a.raw_status = b.raw_status
   and a.ctid > b.ctid;

create unique index clickup_status_map_global_raw_status_uidx
  on portal.clickup_status_map (raw_status) where tenant_id is null;

alter table portal.clickup_status_map
  add column status_key text references portal.task_statuses(key);

update portal.clickup_status_map set status_key = case lower(raw_status)
  when 'to do'            then 'to_do'
  when 'open'             then 'to_do'
  when 'backlog'          then 'backlog'
  when 'planned'          then 'planning'
  when 'planning'         then 'planning'
  when 'ready to develop' then 'ready_to_develop'
  when 'in progress'      then 'in_progress'
  when 'blocked'          then 'blocked'
  when 'in review'        then 'internal_review'
  when 'review'           then 'internal_review'
  when 'internal review'  then 'internal_review'
  when 'in client review' then 'client_review'
  when 'complete'         then 'complete'
  when 'done'             then 'complete'
  when 'closed'           then 'complete'
  when 'live'             then 'live'
end;

-- Anything a tenant added by hand that the list above does not know falls back
-- to the bucket's plainest status, so the column can be NOT NULL.
update portal.clickup_status_map set status_key = case bucket
  when 'upcoming'    then 'to_do'
  when 'in_progress' then 'in_progress'
  when 'delivered'   then 'complete'
end where status_key is null;

alter table portal.clickup_status_map alter column status_key set not null;

-- Make sure every real status has a global row (idempotent — 0042 may have
-- already added some of these).
insert into portal.clickup_status_map (tenant_id, raw_status, bucket, sort_order, status_key)
select null, v.raw_status, s.bucket, s.sort_order, s.key
  from (values
    ('to do', 'to_do'), ('backlog', 'backlog'), ('planning', 'planning'),
    ('ready to develop', 'ready_to_develop'), ('in progress', 'in_progress'),
    ('blocked', 'blocked'), ('internal review', 'internal_review'),
    ('in client review', 'client_review'), ('complete', 'complete'), ('live', 'live')
  ) as v(raw_status, key)
  join portal.task_statuses s on s.key = v.key
on conflict (raw_status) where tenant_id is null do nothing;

-- ----------------------------------------------------------------------------
-- task_cache: resolved key + manual override
-- ----------------------------------------------------------------------------

alter table portal.task_cache
  add column status_key          text references portal.task_statuses(key),
  add column status_override_key text references portal.task_statuses(key),
  add column status_override_by  uuid references core.profiles(id) on delete set null,
  add column status_override_at  timestamptz;

comment on column portal.task_cache.status_key is
  'Catalogue key the sync resolved from ClickUp''s status via clickup_status_map. Null when the raw status is unmapped.';
comment on column portal.task_cache.status_override_key is
  'Status set by hand in the Hub. Wins over status_key until ClickUp''s own status changes, which clears it. Never written back to ClickUp.';

-- Backfill from the map: a tenant row wins over the global one, as getStatusMap() does.
update portal.task_cache tc
   set status_key = coalesce(
     (select m.status_key from portal.clickup_status_map m
       where m.tenant_id = tc.tenant_id and lower(m.raw_status) = lower(tc.status_raw) limit 1),
     (select m.status_key from portal.clickup_status_map m
       where m.tenant_id is null and lower(m.raw_status) = lower(tc.status_raw) limit 1))
 where tc.status_raw is not null;

create index task_cache_status_key_idx on portal.task_cache (tenant_id, status_key);
