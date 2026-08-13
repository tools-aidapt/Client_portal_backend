-- 0033  core readiness for the LMS / Support Desk identity consolidation
-- ----------------------------------------------------------------------------
-- Purely additive — nothing here touches lms.*, support.*, or public.sd_*, and
-- no existing row's shape changes in a breaking way. This is core's side of the
-- prep work; retiring LMS_users/sd_users and re-pointing their real data at
-- core.profiles is a separate, later migration once real-data identity
-- resolution (does this person already have a core.profiles row under the same
-- email?) has actually been checked.
--
-- core.profiles.is_active
--   LMS_users.active and sd_users.is_active both track "can this person log in
--   at all" — a fact core had no answer for before (only per-tenant
--   memberships.status existed). Needed before either app's users can be
--   represented purely by a core.profiles row.
--
-- core.tenants.logo_url
--   LMS_client_groups.logo_url is a reusable fact every app could want, not
--   LMS-specific. LMS_client_groups.is_protected is deliberately NOT added
--   here — it's a narrower LMS-only concept, left for LMS's own schema if it's
--   still needed once LMS_client_groups is retired.
--
-- core.app_access
--   Once identity lives in one place, "does a row exist in this app's own user
--   table" stops being able to answer "does this person have access to that
--   app." This table is the explicit replacement — one row per (person, app)
--   they can open. Portal is deliberately never a row here: having a
--   core.profiles row at all already means you can attempt to log into the
--   Portal; LMS and Support Desk access is what actually needs granting.
--
-- core.external_identity_links
--   A permanent crosswalk recording "this core.profiles row used to be
--   LMS_users row X / sd_users row Y" once the real migration runs — so the
--   history of where someone's account came from is a queryable fact, not a
--   one-time script's lost side effect.
-- ============================================================================

create type core.app_type      as enum ('lms', 'support_desk');
create type core.access_status as enum ('active', 'revoked');

alter table core.profiles add column is_active boolean not null default true;
alter table core.tenants  add column logo_url  text;

create table core.app_access (
  user_id     uuid not null references core.profiles(id) on delete cascade,
  app         core.app_type not null,
  status      core.access_status not null default 'active',
  granted_by  uuid references core.profiles(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  primary key (user_id, app)
);
create index on core.app_access (app, status);

create table core.external_identity_links (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references core.profiles(id) on delete cascade,
  source_system core.app_type not null,
  source_id     uuid not null,
  linked_at     timestamptz not null default now(),
  unique (source_system, source_id)
);
create index on core.external_identity_links (profile_id);
