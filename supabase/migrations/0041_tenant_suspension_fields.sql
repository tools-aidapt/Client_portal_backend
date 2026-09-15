-- ============================================================================
-- 0041  Tenant suspension bookkeeping — who switched a client off, when, and
--       what to put back when they switch it on again
-- ============================================================================
--
-- Runs after 0040, which added the enum value. Everything here USES
-- 'suspended', which is exactly why it cannot be in that file (see its header).

alter table core.tenants
  -- The lifecycle status this tenant held before it was suspended, so resuming
  -- restores the truth rather than guessing 'active' at a tenant that was
  -- halfway through onboarding. Null whenever the tenant is not suspended, and
  -- cleared on resume so a stale value can never be restored twice.
  add column if not exists status_before_suspension core.tenant_status,
  add column if not exists suspended_at timestamptz,
  -- `on delete set null`, matching 0012: a live suspension must not be
  -- undeletable just because the staff account that applied it is being
  -- removed. These four columns are CURRENT STATE, not history — they are
  -- cleared on resume, and the durable record of every suspension and
  -- resumption is written to `core.audit_log` by the service.
  add column if not exists suspended_by uuid references core.profiles(id) on delete set null,
  add column if not exists suspension_reason text;

comment on column core.tenants.status_before_suspension is
  'Lifecycle status to restore on resume. Set only while status = ''suspended''.';
comment on column core.tenants.suspension_reason is
  'Internal note for Aidapt staff. Never shown to the client — the sign-in refusal is deliberately generic.';

-- Suspension bookkeeping is meaningless unless the tenant is actually
-- suspended, and a suspended tenant with no remembered previous status could
-- only ever be resumed by guessing. Enforced in the database rather than in
-- the service so a hand-written UPDATE cannot leave the pair half-set and
-- strand a client in a state nothing can lift.
alter table core.tenants
  drop constraint if exists tenants_suspension_coherent;

alter table core.tenants
  add constraint tenants_suspension_coherent check (
    (status = 'suspended'
       and status_before_suspension is not null
       and suspended_at is not null)
    or
    (status <> 'suspended'
       and status_before_suspension is null
       and suspended_at is null)
  );

-- The sign-in gate asks "does this user hold any membership in a tenant that
-- is NOT suspended", which joins memberships out to tenants on every login and
-- every token refresh. A partial index keeps the suspended set tiny and
-- separately addressable — in practice almost nothing is suspended at once.
create index if not exists tenants_suspended_idx
  on core.tenants (id)
  where status = 'suspended';
