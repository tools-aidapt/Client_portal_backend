-- ============================================================================
-- 0003  core schema — shared identity, tenancy, notifications, documents, audit
-- ============================================================================

create table core.tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,                 -- trading name (no legal suffix)
  slug                  text not null unique,
  status                core.tenant_status not null default 'prospect',
  clickup_folder_id     text,
  clickup_client_group  text,
  product_tier          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table core.tenant_email_domains (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  domain        text not null unique,
  default_role  core.user_role not null default 'member_plus',
  auto_join     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index on core.tenant_email_domains (tenant_id);

create table core.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  full_name          text,
  avatar_url         text,
  job_title          text,
  phone              text,
  locale             text default 'en',
  is_platform_admin  boolean not null default false,
  created_at         timestamptz not null default now()
);

create table core.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references core.profiles(id) on delete cascade,
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  role        core.user_role not null default 'member',
  status      core.membership_status not null default 'active',
  invited_by  uuid references core.profiles(id),
  joined_at   timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create index on core.memberships (tenant_id);
create index on core.memberships (user_id);

create table core.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  email       text not null,
  role        core.user_role not null default 'member',
  token       text not null unique default encode(gen_random_bytes(24),'hex'),
  status      core.invitation_status not null default 'pending',
  invited_by  uuid references core.profiles(id),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index on core.invitations (email) where status = 'pending';
create index on core.invitations (tenant_id);

create table core.documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  title         text not null,
  storage_path  text,                                  -- Supabase Storage object key
  external_url  text,
  doc_type      text,
  size_bytes    bigint,
  uploaded_by   uuid references core.profiles(id),
  created_at    timestamptz not null default now(),
  check (storage_path is not null or external_url is not null)
);
create index on core.documents (tenant_id);

create table core.notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  user_id     uuid not null references core.profiles(id) on delete cascade,
  type        core.notification_type not null,
  title       text not null,
  body        text,
  link_url    text,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on core.notifications (user_id, is_read);

create table core.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references core.profiles(id),
  tenant_id   uuid references core.tenants(id),
  action      text not null,
  target      text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index on core.audit_log (tenant_id, created_at desc);
