-- 0038 — make core.app_access usable as the single source of truth for
-- "which of the three apps can this person open", and let an invitation carry
-- that choice.
--
-- BACKGROUND
-- core.app_access has existed for a while with the right shape, but it is
-- WRITE-ONLY: LMS writes grant/revoke, Support Desk writes on user creation,
-- the Portal never touches it, and nothing anywhere SELECTs it. Each app
-- decides access its own way instead:
--   Portal        is_platform_admin OR any active membership
--   Support Desk  an sd_desk_agents row (staff) OR any active membership
--   LMS           its own LMS_users table, bridged by external_identity_links
-- On top of that, accepting an invitation unconditionally provisions the person
-- into LMS and Support Desk, so the effective default today is "everyone gets
-- everything".
--
-- This migration does the DATA half. It is deliberately additive: enforcement
-- lands in application code afterwards, and would lock people out if the rows
-- were not right first.
--
-- GRANDFATHERING
-- Every row inserted below mirrors access the person ALREADY has today, so
-- switching enforcement on changes nothing for anyone currently using the
-- system. Verified before writing: 92 rows to insert, and ZERO existing active
-- rows belong to someone who would not qualify — so nothing needs revoking and
-- this migration never removes access.

begin;

-- ── Portal ───────────────────────────────────────────────────────────────────
-- Anyone the Portal lets in today: a platform admin, or an active membership.
insert into core.app_access (user_id, app, status)
select distinct p.id, 'portal'::core.app_type, 'active'::core.access_status
  from core.profiles p
 where p.is_platform_admin
    or exists (select 1 from core.memberships m
                where m.user_id = p.id and m.status = 'active')
on conflict (user_id, app) do nothing;

-- ── Support Desk ─────────────────────────────────────────────────────────────
-- Mirrors resolveUser(): a staff desk-agent row, or any active membership
-- (which is how client contacts get in).
insert into core.app_access (user_id, app, status)
select distinct p.id, 'support_desk'::core.app_type, 'active'::core.access_status
  from core.profiles p
 where exists (select 1 from support.sd_desk_agents da
                where da.user_id = p.id and da.is_active)
    or exists (select 1 from core.memberships m
                where m.user_id = p.id and m.status = 'active')
on conflict (user_id, app) do nothing;

-- ── LMS ──────────────────────────────────────────────────────────────────────
-- LMS keeps its own user table; core.external_identity_links is the bridge, so
-- a link is the honest signal that an LMS account exists for this person.
insert into core.app_access (user_id, app, status)
select distinct p.id, 'lms'::core.app_type, 'active'::core.access_status
  from core.profiles p
 where exists (select 1 from core.external_identity_links l
                where l.profile_id = p.id and l.source_system = 'lms')
on conflict (user_id, app) do nothing;

-- ── Invitations carry the app choice ─────────────────────────────────────────
-- Default '{portal}': inviting someone should give them the Portal and nothing
-- else unless the inviter deliberately ticks more. Existing pending invitations
-- keep today's behaviour explicitly rather than silently narrowing — they were
-- created under the "everything" rule and people are waiting on them.
alter table core.invitations
  add column if not exists apps core.app_type[] not null default '{portal}'::core.app_type[];

update core.invitations
   set apps = '{portal,lms,support_desk}'::core.app_type[]
 where status = 'pending';

comment on column core.invitations.apps is
  'Apps to grant when this invitation is accepted. Defaults to {portal}; the inviter opts into more. Pending invitations created before 0038 were set to all three, matching the unconditional provisioning they were issued under.';

commit;
