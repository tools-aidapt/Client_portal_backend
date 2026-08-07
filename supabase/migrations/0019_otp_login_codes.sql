-- ============================================================================
-- 0019  OTP login codes — passwordless sign-in alongside email/password
-- ----------------------------------------------------------------------------
-- Adds a second, optional sign-in method: a 6-digit code emailed on request
-- and exchanged for a token pair, for accounts that already have credentials
-- (`core.user_credentials`). Does not replace password login — both remain
-- available; the client chooses per attempt.
-- ============================================================================

create table core.otp_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references core.profiles(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);

-- Fast lookup of the latest live code for a user.
create index otp_codes_user_active_idx on core.otp_codes (user_id, created_at desc)
  where consumed_at is null;

-- Same deny-all posture as user_credentials/refresh_tokens (migration 0014):
-- codes must never be reachable via the anon/authenticated REST path.
alter table core.otp_codes enable row level security;
