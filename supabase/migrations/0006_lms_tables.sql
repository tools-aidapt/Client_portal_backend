-- ============================================================================
-- 0006  lms schema
-- ----------------------------------------------------------------------------
-- Owned by the LMS team; included here because it lives in the shared database
-- and its tables reference core.tenants / core.profiles. The Portal only READS
-- lms.tenant_enablement_summary (for the dashboard tile); it never touches the
-- working tables.
-- ============================================================================

create table lms.courses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references core.tenants(id) on delete cascade,  -- null = global catalogue
  title        text not null,
  description  text,
  is_published boolean not null default false,
  created_at   timestamptz not null default now()
);

create table lms.modules (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references lms.courses(id) on delete cascade,
  title       text not null,
  sequence    int not null default 0
);
create index on lms.modules (course_id, sequence);

create table lms.enrolments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  user_id     uuid not null references core.profiles(id) on delete cascade,
  course_id   uuid not null references lms.courses(id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  unique (user_id, course_id)
);
create index on lms.enrolments (tenant_id);

create table lms.progress (
  id            uuid primary key default gen_random_uuid(),
  enrolment_id  uuid not null references lms.enrolments(id) on delete cascade,
  module_id     uuid not null references lms.modules(id) on delete cascade,
  completed     boolean not null default false,
  completed_at  timestamptz,
  unique (enrolment_id, module_id)
);

-- Small denormalised summary the Portal dashboard tile reads. Written by LMS.
create table lms.tenant_enablement_summary (
  tenant_id           uuid primary key references core.tenants(id) on delete cascade,
  active_learners     int not null default 0,
  courses_assigned    int not null default 0,
  avg_completion_pct  numeric(5,2) not null default 0,
  updated_at          timestamptz not null default now()
);
