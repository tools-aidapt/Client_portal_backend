-- ============================================================================
-- 0010  Storage bucket + policies
-- ----------------------------------------------------------------------------
-- One private bucket. Objects are keyed `tenant_<uuid>/...`. Direct client
-- access mirrors the same core.is_member() check; downloads in the app go
-- through short-lived signed URLs minted server-side (service role).
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('tenant-files', 'tenant-files', false)
on conflict (id) do nothing;

-- Resolve the tenant id embedded in the object key's first path segment.
create or replace function core.storage_tenant_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(split_part(object_name, '/', 1), '^tenant_', ''), '')::uuid;
$$;

create policy "tenant_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-files'
    and (
      core.is_platform_admin()
      or core.is_member(core.storage_tenant_id(name))
    )
  );

-- Uploads/deletes are performed server-side with the service role, so no
-- authenticated insert/update/delete policy is defined here by design.
