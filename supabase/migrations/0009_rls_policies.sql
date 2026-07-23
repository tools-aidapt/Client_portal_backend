-- ============================================================================
-- 0009  Row Level Security
-- ----------------------------------------------------------------------------
-- Model: RLS is the second line of defence behind JWT claims. The browser holds
-- only the anon key and acts as `authenticated`; all background writers use the
-- service role, which BYPASSES RLS. So policies below mostly grant SELECT and a
-- few client-initiated writes; bulk/system writes need no policy.
--
-- Standard read pattern:  core.is_platform_admin() OR core.is_member(tenant_id)
-- Role-gated read:        ... AND core.tenant_role(tenant_id) = '<role>'
-- ============================================================================

-- ===========================================================================
-- core
-- ===========================================================================
alter table core.tenants               enable row level security;
alter table core.tenant_email_domains  enable row level security;
alter table core.profiles              enable row level security;
alter table core.memberships           enable row level security;
alter table core.invitations           enable row level security;
alter table core.documents             enable row level security;
alter table core.notifications         enable row level security;
alter table core.audit_log             enable row level security;
alter table core.client_onboarding     enable row level security;
alter table core.onboarding_steps      enable row level security;
alter table core.outbox                enable row level security;

-- tenants: a member can see their own tenant; platform admin sees all.
create policy tenants_read on core.tenants
  for select using (core.is_platform_admin() or core.is_member(id));

create policy email_domains_read on core.tenant_email_domains
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- profiles: users see their own; platform admin sees all.
create policy profiles_read_self on core.profiles
  for select using (id = auth.uid() or core.is_platform_admin());
create policy profiles_update_self on core.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
-- The custom access token hook reads profiles as supabase_auth_admin.
create policy profiles_read_auth_admin on core.profiles
  for select to supabase_auth_admin using (true);

-- memberships: users see their own rows; platform admin sees all.
create policy memberships_read_self on core.memberships
  for select using (user_id = auth.uid() or core.is_platform_admin());
-- The custom access token hook reads memberships as supabase_auth_admin.
create policy memberships_read_auth_admin on core.memberships
  for select to supabase_auth_admin using (true);

-- invitations / onboarding / outbox / audit: platform-admin observability only.
-- (All real writes come from the service role, which bypasses RLS.)
create policy invitations_admin on core.invitations
  for select using (core.is_platform_admin());
create policy audit_admin on core.audit_log
  for select using (core.is_platform_admin());
create policy onboarding_admin on core.client_onboarding
  for select using (core.is_platform_admin());
create policy onboarding_steps_admin on core.onboarding_steps
  for select using (core.is_platform_admin());
create policy outbox_admin on core.outbox
  for select using (core.is_platform_admin());

-- documents: members read their tenant's docs; only platform admin writes (v1).
create policy documents_read on core.documents
  for select using (core.is_platform_admin() or core.is_member(tenant_id));
create policy documents_write on core.documents
  for insert with check (core.is_platform_admin());

-- notifications: users read and mark-read their own only.
create policy notifications_read_self on core.notifications
  for select using (user_id = auth.uid());
create policy notifications_update_self on core.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===========================================================================
-- portal
-- ===========================================================================
alter table portal.clickup_list_mappings enable row level security;
alter table portal.clickup_status_map     enable row level security;
alter table portal.sprints                enable row level security;
alter table portal.task_cache             enable row level security;
alter table portal.wishlist_items         enable row level security;
alter table portal.voting_cycles          enable row level security;
alter table portal.wishlist_votes         enable row level security;
alter table portal.reports                enable row level security;
alter table portal.sprint_pulse           enable row level security;
alter table portal.pod_members            enable row level security;
alter table portal.sigma_embeds           enable row level security;
alter table portal.automation_workflows   enable row level security;
alter table portal.automation_health      enable row level security;
alter table portal.sync_runs              enable row level security;

-- Config tables: admin-only via RLS (the sync workers read them as service role).
create policy list_mappings_admin on portal.clickup_list_mappings
  for select using (core.is_platform_admin());
create policy status_map_admin on portal.clickup_status_map
  for select using (core.is_platform_admin());

-- sprints: non-sensitive metadata, readable by any authenticated user.
create policy sprints_read on portal.sprints
  for select to authenticated using (true);

-- task_cache: Project Progress + Sprint Line (client_visible filtered in query).
create policy task_cache_read on portal.task_cache
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- wishlist: members read; MemberPlus/MemberPro submit for their own tenant.
create policy wishlist_read on portal.wishlist_items
  for select using (core.is_platform_admin() or core.is_member(tenant_id));
create policy wishlist_submit on portal.wishlist_items
  for insert with check (
    core.tenant_role(tenant_id) in ('member_plus','member_pro')
    and submitted_by = auth.uid()
  );

create policy cycles_read on portal.voting_cycles
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- votes: user reads own + admin; insert requires MemberPlus+ and an open cycle.
create policy votes_read on portal.wishlist_votes
  for select using (user_id = auth.uid() or core.is_platform_admin());
create policy votes_insert on portal.wishlist_votes
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from portal.voting_cycles c
      where c.id = cycle_id
        and c.is_open
        and core.tenant_role(c.tenant_id) in ('member_plus','member_pro')
    )
  );

-- reports: MemberPro only (capability matrix). Admin writes.
create policy reports_read on portal.reports
  for select using (
    core.is_platform_admin() or core.tenant_role(tenant_id) = 'member_pro'
  );

-- sprint pulse: MemberPro submits their own; user reads own + admin.
create policy pulse_read on portal.sprint_pulse
  for select using (user_id = auth.uid() or core.is_platform_admin());
create policy pulse_insert on portal.sprint_pulse
  for insert with check (
    user_id = auth.uid()
    and core.tenant_role(tenant_id) = 'member_pro'
  );

create policy pod_read on portal.pod_members
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

create policy sigma_read on portal.sigma_embeds
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

create policy automations_read on portal.automation_workflows
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- automation_health has no tenant_id; resolve via the parent workflow.
create policy automation_health_read on portal.automation_health
  for select using (
    core.is_platform_admin() or exists (
      select 1 from portal.automation_workflows w
      where w.id = workflow_id and core.is_member(w.tenant_id)
    )
  );

create policy sync_runs_admin on portal.sync_runs
  for select using (core.is_platform_admin());

-- ===========================================================================
-- lms  (read policies for the shared DB; the LMS team owns write policies)
-- ===========================================================================
alter table lms.courses                   enable row level security;
alter table lms.modules                    enable row level security;
alter table lms.enrolments                 enable row level security;
alter table lms.progress                   enable row level security;
alter table lms.tenant_enablement_summary  enable row level security;

create policy courses_read on lms.courses
  for select using (
    tenant_id is null or core.is_platform_admin() or core.is_member(tenant_id)
  );

create policy modules_read on lms.modules
  for select using (
    exists (
      select 1 from lms.courses c
      where c.id = course_id
        and (c.tenant_id is null or core.is_platform_admin() or core.is_member(c.tenant_id))
    )
  );

create policy enrolments_read_self on lms.enrolments
  for select using (user_id = auth.uid() or core.is_platform_admin());

create policy progress_read_self on lms.progress
  for select using (
    exists (
      select 1 from lms.enrolments e
      where e.id = enrolment_id and (e.user_id = auth.uid() or core.is_platform_admin())
    )
  );

-- Portal dashboard tile reads this summary.
create policy enablement_summary_read on lms.tenant_enablement_summary
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- ===========================================================================
-- support  (read policies for the shared DB; the Support team owns write policies)
-- ===========================================================================
alter table support.categories               enable row level security;
alter table support.tickets                   enable row level security;
alter table support.ticket_messages           enable row level security;
alter table support.tenant_support_summary    enable row level security;

create policy categories_read on support.categories
  for select using (
    tenant_id is null or core.is_platform_admin() or core.is_member(tenant_id)
  );

create policy tickets_read on support.tickets
  for select using (core.is_platform_admin() or core.is_member(tenant_id));

-- Ticket messages: visible to tenant members, but internal notes are staff-only.
create policy ticket_messages_read on support.ticket_messages
  for select using (
    exists (
      select 1 from support.tickets t
      where t.id = ticket_id
        and (core.is_platform_admin() or (core.is_member(t.tenant_id) and not is_internal))
    )
  );

-- Portal dashboard tile reads this summary.
create policy support_summary_read on support.tenant_support_summary
  for select using (core.is_platform_admin() or core.is_member(tenant_id));
