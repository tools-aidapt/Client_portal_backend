-- ============================================================================
-- 0004  core schema — onboarding state machine + transactional outbox
-- ----------------------------------------------------------------------------
-- Client registration is a state machine: internal rows are written in one DB
-- transaction; external side effects are enqueued to `core.outbox` in the SAME
-- transaction and drained asynchronously with retries + idempotency keys.
-- ============================================================================

create table core.client_onboarding (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  state         core.onboarding_state not null default 'pending',
  started_by    uuid references core.profiles(id),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  unique (tenant_id)
);

create table core.onboarding_steps (
  id              uuid primary key default gen_random_uuid(),
  onboarding_id   uuid not null references core.client_onboarding(id) on delete cascade,
  step_key        text not null,        -- 'create_tenant','link_clickup','provision_lms', ...
  status          core.step_status not null default 'pending',
  sequence        int not null,
  detail          jsonb,
  attempts        int not null default 0,
  updated_at      timestamptz not null default now(),
  unique (onboarding_id, step_key)
);
create index on core.onboarding_steps (onboarding_id, sequence);

create table core.outbox (
  id              uuid primary key default gen_random_uuid(),
  aggregate       text not null,        -- 'onboarding'
  aggregate_id    uuid not null,        -- onboarding_id
  event_type      text not null,        -- 'clickup.provision_folder','n8n.trigger_sync','email.invite'
  payload         jsonb not null,
  status          core.outbox_status not null default 'pending',
  attempts        int not null default 0,
  idempotency_key text unique,          -- dedupes retries against the external system
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now()
);
-- Worker claim index: fetch due, pending/failed rows in FIFO order.
create index on core.outbox (status, next_attempt_at);
create index on core.outbox (aggregate, aggregate_id);
