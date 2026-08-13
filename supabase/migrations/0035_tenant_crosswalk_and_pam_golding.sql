-- 0035  tenant/client-group crosswalk, plus the new Pam Golding Properties tenant
-- ----------------------------------------------------------------------------
-- Mirrors core.external_identity_links but for tenants instead of people:
-- support.sd_clients rows and lms.LMS_client_groups rows both describe "which
-- client" in their own vocabulary, and this records how each maps onto the
-- one real core.tenants row.
--
-- Pam Golding Properties is a real client (confirmed) that was never onboarded
-- as a Portal tenant — created the same way HBL was, status 'onboarding',
-- no ClickUp folder yet.
-- ============================================================================

insert into core.tenants (name, slug, status)
values ('Pam Golding Properties', 'pam-golding', 'onboarding');

create table core.external_tenant_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  source_system core.app_type not null,
  source_id     uuid not null,
  linked_at     timestamptz not null default now(),
  unique (source_system, source_id)
);
create index on core.external_tenant_links (tenant_id);
