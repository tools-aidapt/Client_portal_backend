-- ============================================================================
-- 0001  Extensions, schemas, and role grants
-- ----------------------------------------------------------------------------
-- One Postgres database, four schemas. `core` holds shared identity/tenancy and
-- is readable by every app schema. Each app owns its own schema.
--
-- Roles (Supabase-managed):
--   anon               unauthenticated browser (only reaches public endpoints)
--   authenticated      logged-in user; a user-scoped client -> RLS enforced
--   service_role       trusted server workers; BYPASSRLS by design
--   supabase_auth_admin runs the custom access token hook
-- ============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid(), gen_random_bytes()

create schema if not exists core;
create schema if not exists portal;
create schema if not exists lms;
create schema if not exists support;

-- ----------------------------------------------------------------------------
-- Schema usage. Custom schemas must ALSO be added to the PostgREST "Exposed
-- schemas" list in the Supabase dashboard (API settings) for supabase-js to
-- reach them: expose `core, portal`. lms/support are reached by their own apps.
-- ----------------------------------------------------------------------------
grant usage on schema core    to anon, authenticated, service_role;
grant usage on schema portal  to anon, authenticated, service_role;
grant usage on schema lms     to anon, authenticated, service_role;
grant usage on schema support to anon, authenticated, service_role;

-- Table DML is granted broadly; Row Level Security (0009) is what actually gates
-- access for anon/authenticated. service_role bypasses RLS entirely.
do $$
declare s text;
begin
  foreach s in array array['core','portal','lms','support'] loop
    execute format(
      'grant select, insert, update, delete on all tables in schema %I to authenticated', s);
    execute format(
      'grant select on all tables in schema %I to anon', s);
    execute format(
      'grant all on all tables in schema %I to service_role', s);
    execute format(
      'grant usage, select on all sequences in schema %I to authenticated, service_role', s);

    -- Same grants for tables/sequences created by later migrations.
    execute format(
      'alter default privileges in schema %I grant select, insert, update, delete on tables to authenticated', s);
    execute format(
      'alter default privileges in schema %I grant select on tables to anon', s);
    execute format(
      'alter default privileges in schema %I grant all on tables to service_role', s);
    execute format(
      'alter default privileges in schema %I grant usage, select on sequences to authenticated, service_role', s);
  end loop;
end $$;
