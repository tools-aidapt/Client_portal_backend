-- ============================================================================
-- 0015  Richer profile fields
-- ----------------------------------------------------------------------------
-- Collected at registration and editable via PATCH /auth/me. avatar_url,
-- job_title, phone, locale already exist on core.profiles (migration 0003).
-- ============================================================================

alter table core.profiles add column if not exists department text;
alter table core.profiles add column if not exists interests  text[];
