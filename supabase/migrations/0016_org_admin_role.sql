-- ============================================================================
-- 0016  Add the client-side `org_admin` role
-- ----------------------------------------------------------------------------
-- A per-tenant administrator: full MemberPro visibility PLUS the ability to
-- invite/manage users WITHIN their own org. Distinct from `super_admin`, which
-- is Aidapt platform staff with cross-tenant access. Ranked between member_pro
-- and super_admin in the app's role hierarchy.
-- ============================================================================

alter type core.user_role add value if not exists 'org_admin' after 'member_pro';
