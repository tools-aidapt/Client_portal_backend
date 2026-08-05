-- ============================================================================
-- 0014  Self-hosted auth — credentials + refresh tokens
-- ----------------------------------------------------------------------------
-- Decouples identity from Supabase Auth (`auth.users`). Profiles now own their
-- own primary key, credentials live in `core.user_credentials`, and refresh
-- tokens are stored hashed in `core.refresh_tokens` so logout can revoke them.
-- Access-token claims (platform_admin / tenant_roles) are stamped by the API at
-- sign-in, replacing the never-enabled `core.custom_access_token_hook`.
-- ============================================================================

-- Profiles no longer depend on Supabase's auth.users; the API generates the id.
alter table core.profiles drop constraint if exists profiles_id_fkey;
alter table core.profiles alter column id set default gen_random_uuid();

-- Email + password hash for each profile. Email is unique case-insensitively.
create table core.user_credentials (
  user_id        uuid primary key references core.profiles(id) on delete cascade,
  email          text not null,
  password_hash  text not null,
  email_verified boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index user_credentials_email_lower_key on core.user_credentials (lower(email));

-- Opaque refresh tokens, stored as SHA-256 hashes (never the raw value).
-- Rotated on every refresh; revoked on logout or password change.
create table core.refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references core.profiles(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index refresh_tokens_active_idx on core.refresh_tokens (user_id) where revoked_at is null;

-- Credentials and refresh tokens must NEVER be reachable via the REST API / anon
-- key. Enable RLS with no policies: anon/authenticated are denied outright, while
-- the API's postgres/service-role connection bypasses RLS. (migration 0001
-- granted anon SELECT on core tables, so this deny-all is essential.)
alter table core.user_credentials enable row level security;
alter table core.refresh_tokens   enable row level security;
