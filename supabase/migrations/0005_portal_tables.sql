-- ============================================================================
-- 0005  portal schema — delivery cache, wishlist, reports, pulse, pod, sigma,
--                        automation health, sync bookkeeping
-- ============================================================================

-- ClickUp list-to-purpose mapping per tenant.
create table portal.clickup_list_mappings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  purpose         text not null,        -- 'onboarding'|'project'|'wishlist'|'offboarding'
  clickup_list_id text not null,
  display_label   text,
  is_active       boolean not null default true,
  unique (tenant_id, clickup_list_id)
);

-- Raw ClickUp status -> client-facing bucket. Null tenant = global default.
create table portal.clickup_status_map (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references core.tenants(id) on delete cascade,
  raw_status  text not null,
  bucket      portal.task_bucket not null,
  sort_order  int not null default 0,
  unique (tenant_id, raw_status)
);

create table portal.sprints (
  id               uuid primary key default gen_random_uuid(),
  clickup_list_id  text not null unique,
  sprint_number    int,
  name             text not null,
  starts_on        date,
  ends_on          date,
  is_active        boolean not null default false,
  synced_at        timestamptz not null default now()
);

-- Feeds Project Progress (source='delivery') and the Sprint Line (source='sprint').
create table portal.task_cache (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  clickup_task_id  text not null unique,
  source           portal.task_source not null,
  sprint_id        uuid references portal.sprints(id),
  clickup_list_id  text,
  list_name        text,
  name             text not null,
  status_raw       text,
  bucket           portal.task_bucket,
  rag              portal.rag_status,
  progress_pct     numeric(5,2),
  type_of_work     text,
  client_visible   boolean not null default false,
  assignee_names   text[],
  start_date       date,
  due_date         date,
  closed_at        timestamptz,
  url              text,
  synced_at        timestamptz not null default now()
);
create index on portal.task_cache (tenant_id, source);
create index on portal.task_cache (sprint_id) where source = 'sprint';

create table portal.wishlist_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  clickup_task_id  text,
  title            text not null,
  description      text,
  state            portal.wishlist_state not null default 'candidate',
  submitted_by     uuid references core.profiles(id),
  created_at       timestamptz not null default now()
);
create index on portal.wishlist_items (tenant_id);

create table portal.voting_cycles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  period_month     date not null,
  opens_at         timestamptz not null,
  closes_at        timestamptz not null,
  is_open          boolean not null default true,
  winning_item_id  uuid references portal.wishlist_items(id),
  unique (tenant_id, period_month)
);

create table portal.wishlist_votes (
  id          uuid primary key default gen_random_uuid(),
  cycle_id    uuid not null references portal.voting_cycles(id) on delete cascade,
  item_id     uuid not null references portal.wishlist_items(id) on delete cascade,
  user_id     uuid not null references core.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (cycle_id, item_id, user_id)
);

create table portal.reports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  sprint_id        uuid references portal.sprints(id),
  title            text not null,
  period_start     date not null,
  period_end       date not null,
  summary_md       text,
  committed_count  int,
  delivered_count  int,
  status           portal.report_status not null default 'draft',
  published_at     timestamptz,
  published_by     uuid references core.profiles(id),
  created_at       timestamptz not null default now()
);
create index on portal.reports (tenant_id, status);

create table portal.sprint_pulse (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  report_id   uuid not null references portal.reports(id) on delete cascade,
  sprint_id   uuid references portal.sprints(id),
  user_id     uuid not null references core.profiles(id) on delete cascade,
  score       int not null check (score between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (report_id, user_id)
);

create table portal.pod_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  display_name text not null,
  role_label   text not null,          -- 'Pod Lead','AI Engineer','AI Implementation'
  avatar_url   text,
  sort_order   int not null default 0,
  is_active    boolean not null default true
);
create index on portal.pod_members (tenant_id);

create table portal.sigma_embeds (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  embed_name         text not null,
  sigma_workbook_id  text not null,
  embed_type         text not null default 'roi',
  is_active          boolean not null default true
);
create index on portal.sigma_embeds (tenant_id);

create table portal.automation_workflows (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenants(id) on delete cascade,
  n8n_workflow_id    text not null,
  name               text not null,
  description        text,
  is_client_visible  boolean not null default false,
  is_active          boolean not null default true,
  unique (tenant_id, n8n_workflow_id)
);

create table portal.automation_health (
  workflow_id            uuid primary key references portal.automation_workflows(id) on delete cascade,
  state                  portal.workflow_health not null default 'idle',
  last_execution_at      timestamptz,
  last_execution_status  text,
  executions_this_month  int not null default 0,
  errors_this_month      int not null default 0,
  avg_runtime_ms         int,
  captured_at            timestamptz not null default now()
);

create table portal.sync_runs (
  id               uuid primary key default gen_random_uuid(),
  entity           text not null,
  tenant_id        uuid references core.tenants(id),
  status           portal.sync_status not null,
  records_upserted int default 0,
  error_detail     text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index on portal.sync_runs (entity, started_at desc);
