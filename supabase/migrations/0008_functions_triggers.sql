-- ============================================================================
-- 0008  Functions, triggers, and the custom access token hook
-- ----------------------------------------------------------------------------
-- Every function pins `search_path` explicitly and fully-qualifies all names,
-- so behaviour does not depend on the caller's search_path (avoids the
-- SECURITY DEFINER / PostgREST resolution pitfalls noted in review).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function core.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_tenants_updated_at
  before update on core.tenants
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create a profile when an auth user is created (email OTP sign-up).
-- ---------------------------------------------------------------------------
create or replace function core.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into core.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function core.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS helper functions — read tenancy from the JWT claims (fast path, no table
-- hit). STABLE so the planner can cache within a statement.
-- ---------------------------------------------------------------------------

-- Role the current user holds in a given tenant (null if none).
create or replace function core.tenant_role(tid uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(
    auth.jwt() -> 'app_metadata' -> 'tenant_roles' ->> tid::text, ''
  );
$$;

create or replace function core.is_member(tid uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select core.tenant_role(tid) is not null;
$$;

create or replace function core.is_platform_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'platform_admin')::boolean, false
  );
$$;

-- ---------------------------------------------------------------------------
-- Custom access token hook. Runs as `supabase_auth_admin` on every token
-- issue/refresh. Injects the tenant->role map and the platform-admin flag so
-- apps and RLS never query memberships per request.
--
-- NOTE: claims are stamped at issue time, so a role/membership change only
-- takes effect on the next refresh. The role-change endpoint revokes the
-- user's sessions to force an immediate re-stamp.
-- ---------------------------------------------------------------------------
create or replace function core.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  uid uuid := (event ->> 'user_id')::uuid;
  roles jsonb;
  is_admin boolean;
begin
  select coalesce(jsonb_object_agg(m.tenant_id::text, m.role), '{}'::jsonb)
    into roles
  from core.memberships m
  where m.user_id = uid and m.status = 'active';

  select coalesce(p.is_platform_admin, false)
    into is_admin
  from core.profiles p
  where p.id = uid;

  claims := jsonb_set(claims, '{app_metadata,tenant_roles}', coalesce(roles, '{}'::jsonb));
  claims := jsonb_set(claims, '{app_metadata,platform_admin}', to_jsonb(coalesce(is_admin, false)));

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Wire up the hook's privileges (Supabase-recommended pattern). The hook runs
-- as supabase_auth_admin, which must be able to read the two source tables but
-- must NOT be callable by clients.
grant usage on schema core to supabase_auth_admin;
grant execute on function core.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function core.custom_access_token_hook(jsonb) from authenticated, anon, public;

grant select on core.memberships to supabase_auth_admin;
grant select on core.profiles    to supabase_auth_admin;

-- After running this migration, enable the hook in the Supabase dashboard:
--   Authentication -> Hooks -> Custom Access Token -> core.custom_access_token_hook
-- (or set auth.hook.custom_access_token.uri in config).
