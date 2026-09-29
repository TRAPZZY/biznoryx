begin;

create type integration_provider_kind as enum ('accounting', 'commerce', 'crm', 'payments', 'database', 'file_storage', 'custom_api');
create type integration_connection_status as enum ('draft', 'active', 'paused', 'error', 'revoked');
create type integration_sync_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type webhook_event_status as enum ('received', 'processed', 'duplicate', 'failed');

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_source_id uuid references data_sources(id) on delete restrict,
  provider_key text not null,
  provider_kind integration_provider_kind not null,
  display_name text not null,
  status integration_connection_status not null default 'draft',
  scopes text[] not null default '{}',
  secret_ref text,
  config jsonb not null default '{}'::jsonb,
  last_sync_run_id uuid,
  last_successful_sync_at timestamptz,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider_key, display_name)
);

create table integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  integration_connection_id uuid not null references integration_connections(id) on delete restrict,
  idempotency_key text not null,
  status integration_sync_status not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  records_seen integer not null default 0,
  records_accepted integer not null default 0,
  records_rejected integer not null default 0,
  error_code text,
  error_message text,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, integration_connection_id, idempotency_key)
);

alter table integration_connections
  add constraint integration_connections_last_sync_fk
  foreign key (last_sync_run_id) references integration_sync_runs(id) on delete set null;

create table integration_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  integration_connection_id uuid not null references integration_connections(id) on delete restrict,
  provider_event_id text not null,
  idempotency_key text not null,
  status webhook_event_status not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload_fingerprint text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references app_users(id),
  unique (organization_id, integration_connection_id, provider_event_id),
  unique (organization_id, integration_connection_id, idempotency_key)
);

create index integration_connections_org_status_idx on integration_connections(organization_id, status, provider_kind);
create index integration_sync_runs_connection_idx on integration_sync_runs(organization_id, integration_connection_id, created_at desc);
create index integration_webhook_events_connection_idx on integration_webhook_events(organization_id, integration_connection_id, received_at desc);

alter table integration_connections enable row level security;
alter table integration_sync_runs enable row level security;
alter table integration_webhook_events enable row level security;

create policy integration_connections_rls on integration_connections
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy integration_sync_runs_rls on integration_sync_runs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy integration_webhook_events_rls on integration_webhook_events
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
