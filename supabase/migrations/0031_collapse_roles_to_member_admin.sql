-- 0031 — collapse the client role ladder to member / admin / super_admin.
--
-- WHY: roles had to mean the same thing in every Aidapt app. The Portal's five
-- values mapped onto the LMS's three by collapsing (member/member_plus/
-- member_pro all became LMS 'member') while `org_admin` mapped to an 'admin'
-- the LMS's register endpoint rejected outright — so a client's own admin could
-- never be provisioned there at all. Support Desk, meanwhile, flattens every
-- client role to user_type='client' and needs no granularity.
--
--   member_plus -> admin
--   member_pro  -> admin
--   org_admin   -> admin
--   member, super_admin unchanged
--
-- Postgres cannot remove a value from an enum in place, so this rebuilds the
-- type. Every dependent column must be listed below — a missed one fails loudly
-- here rather than silently keeping the old type.

begin;

-- 1. New type with the final three values.
create type core.user_role_new as enum ('member', 'admin', 'super_admin');

-- 2. Repoint every dependent column, folding the retired values on the way.
--    Defaults are dropped first: a default still typed as the old enum blocks
--    the alter, and is restored in step 4.
alter table core.memberships alter column role drop default;
alter table core.invitations alter column role drop default;
alter table core.tenant_email_domains alter column default_role drop default;

alter table core.memberships
  alter column role type core.user_role_new
  using (case role::text
           when 'member_plus' then 'admin'
           when 'member_pro'  then 'admin'
           when 'org_admin'   then 'admin'
           else role::text
         end)::core.user_role_new;

alter table core.invitations
  alter column role type core.user_role_new
  using (case role::text
           when 'member_plus' then 'admin'
           when 'member_pro'  then 'admin'
           when 'org_admin'   then 'admin'
           else role::text
         end)::core.user_role_new;

alter table core.tenant_email_domains
  alter column default_role type core.user_role_new
  using (case default_role::text
           when 'member_plus' then 'admin'
           when 'member_pro'  then 'admin'
           when 'org_admin'   then 'admin'
           else default_role::text
         end)::core.user_role_new;

-- 3. Swap the type name.
drop type core.user_role;
alter type core.user_role_new rename to user_role;

-- 4. Restore defaults, now typed against the new enum.
alter table core.memberships alter column role set default 'member'::core.user_role;
alter table core.invitations alter column role set default 'member'::core.user_role;
alter table core.tenant_email_domains
  alter column default_role set default 'member'::core.user_role;

commit;
