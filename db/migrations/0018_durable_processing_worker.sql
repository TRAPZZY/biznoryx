begin;

create table processing_jobs (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  ingestion_run_id uuid
    references ingestion_runs(id)
    on delete cascade,

  job_type text not null,

  status text not null default 'queued'
    check (
      status in (
        'queued',
        'leased',
        'failed',
        'succeeded',
        'dead'
      )
    ),

  payload jsonb not null default '{}'::jsonb,

  idempotency_key text not null,

  priority integer not null default 100
    check (
      priority between 1 and 1000
    ),

  attempts integer not null default 0
    check (
      attempts >= 0
    ),

  max_attempts integer not null default 5
    check (
      max_attempts between 1 and 20
    ),

  available_at timestamptz not null default now(),

  leased_at timestamptz,

  lease_expires_at timestamptz,

  leased_by text,

  last_error text,

  completed_at timestamptz,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    idempotency_key
  )
);

create index processing_jobs_available_idx
  on processing_jobs (
    status,
    available_at,
    priority,
    created_at
  );

create index processing_jobs_organization_idx
  on processing_jobs (
    organization_id,
    created_at desc
  );

create index processing_jobs_lease_idx
  on processing_jobs (
    status,
    lease_expires_at
  );

create table worker_heartbeats (
  worker_id text primary key,

  status text not null
    check (
      status in (
        'ready',
        'busy',
        'stopping',
        'stopped'
      )
    ),

  started_at timestamptz not null default now(),

  last_seen_at timestamptz not null default now(),

  metadata jsonb not null default '{}'::jsonb
);

create index worker_heartbeats_health_idx
  on worker_heartbeats (
    status,
    last_seen_at desc
  );

create or replace function enqueue_ingestion_processing_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'validated' then
    insert into processing_jobs (
      organization_id,
      ingestion_run_id,
      job_type,
      status,
      payload,
      idempotency_key,
      priority,
      max_attempts
    )
    values (
      new.organization_id,
      new.id,
      'ingestion.verify_storage',
      'queued',
      jsonb_build_object(
        'ingestionRunId',
        new.id,
        'rawDataObjectId',
        new.raw_data_object_id,
        'dataStreamId',
        new.data_stream_id
      ),
      'ingestion.verify_storage:' || new.id::text,
      100,
      5
    )
    on conflict (
      organization_id,
      idempotency_key
    )
    do nothing;
  end if;

  return new;
end;
$$;

create trigger ingestion_run_processing_job_trigger
after insert on ingestion_runs
for each row
execute function enqueue_ingestion_processing_job();

commit;
