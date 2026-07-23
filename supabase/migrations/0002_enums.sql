-- ============================================================================
-- 0002  Enumerated types
-- ============================================================================

-- core -----------------------------------------------------------------------
create type core.user_role         as enum ('super_admin','member','member_plus','member_pro');
create type core.membership_status as enum ('invited','active','suspended');
create type core.invitation_status as enum ('pending','accepted','expired','revoked');
create type core.tenant_status     as enum ('prospect','onboarding','active','offboarded');
create type core.onboarding_state  as enum ('pending','in_progress','completed','failed');
create type core.step_status       as enum ('pending','running','done','failed','skipped');
create type core.outbox_status     as enum ('pending','processing','done','failed','dead');

create type core.notification_type as enum (
  'report_published','voting_opened','voting_results','item_prioritised',
  'role_changed','task_status_changed','document_added','automation_error',
  'course_assigned','ticket_updated'
);

-- portal ---------------------------------------------------------------------
create type portal.task_source     as enum ('delivery','sprint');
create type portal.task_bucket     as enum ('delivered','in_progress','upcoming');
create type portal.rag_status      as enum ('green','amber','red');
create type portal.wishlist_state  as enum ('candidate','prioritised','in_progress','shipped');
create type portal.report_status   as enum ('draft','published','archived');
create type portal.sync_status     as enum ('success','partial','error');
create type portal.workflow_health as enum ('active','idle','error','disabled');
