begin;

set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table source_file_deletion_outbox (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null
      references organizations(id) on delete restrict,
    upload_id uuid not null,
    storage_key text not null,
    requested_by_user_id uuid not null
      references app_users(id),
    requested_at timestamptz not null default now(),
    attempts integer not null default 0,
    last_attempt_at timestamptz,
    completed_at timestamptz,
    unique (organization_id, upload_id)
);

create index source_file_deletion_pending_idx
  on source_file_deletion_outbox
    (organization_id, requested_at)
  where completed_at is null;

alter table source_file_deletion_outbox
  enable row level security;

alter table source_file_deletion_outbox
  force row level security;

create policy source_file_deletion_tenant
  on source_file_deletion_outbox
  using (
    organization_id =
    nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id =
    nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

-- Prevent a content-addressed source from being registered
-- while its previous object is awaiting physical deletion.

create function prevent_pending_source_reuse()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
    source_key text;
begin
    select storage_key into source_key
    from raw_data_objects
    where id = new.raw_data_object_id
      and organization_id = new.organization_id;

    if source_key is null then
        return new;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        new.organization_id::text || ':' || source_key, 0
      )
    );

    if exists (
        select 1
        from source_file_deletion_outbox
        where organization_id = new.organization_id
          and storage_key = source_key
          and completed_at is null
    ) then
        raise exception 'SOURCE_FILE_DELETION_PENDING'
          using errcode = '23514';
    end if;

    return new;
end;
$$;

create trigger prevent_pending_source_reuse_trigger
before insert or update of raw_data_object_id
on ingestion_runs
for each row
execute function prevent_pending_source_reuse();

revoke all on source_file_deletion_outbox from public;

do $$
begin
  if exists (
    select 1 from pg_roles where rolname = 'biznoryx_app'
  ) then
    grant select, insert, update
      on source_file_deletion_outbox to biznoryx_app;

    grant select, delete on processing_jobs to biznoryx_app;

    grant delete on
      ingestion_validation_results,
      ingestion_runs,
      raw_data_objects
      to biznoryx_app;
  end if;
end $$;

commit;