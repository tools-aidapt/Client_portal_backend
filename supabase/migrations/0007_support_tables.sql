-- ============================================================================
-- 0007  support schema
-- ----------------------------------------------------------------------------
-- Owned by the Support Desk team; included here for the same reason as lms.
-- The Portal only READS support.tenant_support_summary for its dashboard tile.
-- ============================================================================

create table support.categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references core.tenants(id) on delete cascade,
  name        text not null,
  sla_hours   int not null default 24
);
create index on support.categories (tenant_id);

create table support.tickets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  requester_id  uuid not null references core.profiles(id),
  category_id   uuid references support.categories(id),
  subject       text not null,
  status        text not null default 'open',   -- open|pending|resolved|closed
  priority      text not null default 'normal',
  assignee      uuid references core.profiles(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index on support.tickets (tenant_id, status);

create table support.ticket_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references support.tickets(id) on delete cascade,
  author_id   uuid not null references core.profiles(id),
  body        text not null,
  is_internal boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on support.ticket_messages (ticket_id, created_at);

-- Small denormalised summary the Portal dashboard tile reads. Written by Support.
create table support.tenant_support_summary (
  tenant_id     uuid primary key references core.tenants(id) on delete cascade,
  open_tickets  int not null default 0,
  breached_sla  int not null default 0,
  updated_at    timestamptz not null default now()
);
