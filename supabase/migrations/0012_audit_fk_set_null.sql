-- ============================================================================
-- 0012  audit_log foreign keys -> ON DELETE SET NULL
-- ----------------------------------------------------------------------------
-- Audit trails must survive deletion of the profile or tenant they reference.
-- The original FKs defaulted to NO ACTION (RESTRICT), which blocks deleting any
-- profile/tenant that has audit rows. Switch both to SET NULL so history is
-- retained (actor_id / tenant_id are already nullable).
-- ============================================================================

alter table core.audit_log
  drop constraint audit_log_actor_id_fkey,
  add constraint audit_log_actor_id_fkey
    foreign key (actor_id) references core.profiles(id) on delete set null;

alter table core.audit_log
  drop constraint audit_log_tenant_id_fkey,
  add constraint audit_log_tenant_id_fkey
    foreign key (tenant_id) references core.tenants(id) on delete set null;
