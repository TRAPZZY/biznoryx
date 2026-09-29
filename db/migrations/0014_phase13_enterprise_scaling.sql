begin;

create type enterprise_plan_status as enum ('active', 'paused', 'cancelled');
create type enterprise_usage_kind as enum ('ingestion_run', 'forecast_run', 'sync_run', 'report_generation');
create type rate_limit_decision as enum ('allowed', 'blocked');
create type worker_job_kind as enum ('ingestion', 'sync', 'metric_calculation', 'forecast', 'report', 'alert_evaluation');
create type worker_job_status as enum ('queued', 'leased', 'succeeded', 'failed', 'cancelled');

create table organization_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null,
  status enterprise_plan_status not null default 'active',
  limits jsonb not null,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table organization_usage_windows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  usage_kind enterprise_usage_kind not null,
  window_start date not null,
  window_end date not null,
  used_quantity integer not null default 0 check (used_quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, usage_kind, window_start),
  check (window_end >= window_start)
);

create table rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  actor_user_id uuid references app_users(id),
  usage_kind enterprise_usage_kind not null,
  operation_key text not null,
  quantity integer not null check (quantity > 0),
  limit_quantity integer not null check (limit_quantity > 0),
  used_quantity integer not null check (used_quantity >= 0),
  decision rate_limit_decision not null,
  created_at timestamptz not null default now()
);

create table worker_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  job_kind worker_job_kind not null,
  idempotency_key text not null,
  status worker_job_status not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, job_kind, idempotency_key)
);

create index organization_plans_org_status_idx on organization_plans(organization_id, status);
create index organization_usage_windows_org_kind_idx on organization_usage_windows(organization_id, usage_kind, window_start);
create index rate_limit_events_org_kind_idx on rate_limit_events(organization_id, usage_kind, created_at desc);
create index worker_jobs_org_status_idx on worker_jobs(organization_id, status, created_at);

alter table organization_plans enable row level security;
alter table organization_usage_windows enable row level security;
alter table rate_limit_events enable row level security;
alter table worker_jobs enable row level security;

create policy organization_plans_rls on organization_plans
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy organization_usage_windows_rls on organization_usage_windows
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy rate_limit_events_rls on rate_limit_events
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy worker_jobs_rls on worker_jobs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
