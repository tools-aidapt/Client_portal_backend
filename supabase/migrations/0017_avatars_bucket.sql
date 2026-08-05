-- ============================================================================
-- 0017  Public avatars storage bucket
-- ----------------------------------------------------------------------------
-- Profile pictures. Public-read (avatars are not sensitive); writes happen
-- server-side with the service role via POST /auth/me/avatar. Objects are keyed
-- `avatars/<user_id>/<file>`.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;
