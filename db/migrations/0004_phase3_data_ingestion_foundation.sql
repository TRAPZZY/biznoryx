begin;

create type data_source_type as enum ('manual_upload', 'api', 'database', 'webhook', 'object_storage');
create type data_stream_grain as enum ('daily', 'weekly', 'monthly', 'quarterly', 'annual', 'ad_hoc');
create type ingestion_run_status as enum ('pending', 'validated', 'rejected');
create type validation_severity as enum ('info', 'warning', 'error');
create type schema_drift_classification as enum ('none', 'compatible', 'potentially_compatible', 'breaking');
create type raw_object_status as enum ('quarantined', 'accepted', 'rejected');

create table data_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null,
  source_type data_source_type not null,
  description text,
  status text not null default 'active',
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table data_streams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_source_id uuid not null references data_sources(id) on delete restrict,
  name text not null,
  display_name text not null,
  grain data_stream_grain not null,
  expected_schema_fingerprint text,
  active_schema_version_id uuid,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, data_source_id, name)
);

create table stream_schema_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null references data_streams(id) on delete restrict,
  version integer not null check (version > 0),
  schema_fingerprint text not null,
  columns jsonb not null,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, data_stream_id, version),
  unique (organization_id, data_stream_id, schema_fingerprint)
);

alter table data_streams
  add constraint data_streams_active_schema_version_fk
  foreign key (active_schema_version_id)
  references stream_schema_versions(id)
  deferrable initially deferred;

create table reporting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null references data_streams(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, data_stream_id, period_start, period_end),
  check (period_end >= period_start)
);

create table raw_data_objects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  storage_key text not null,
  original_filename text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  checksum_sha256 text not null,
  status raw_object_status not null default 'quarantined',
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, storage_key),
  unique (organization_id, checksum_sha256)
);

create table ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_source_id uuid not null references data_sources(id) on delete restrict,
  data_stream_id uuid not null references data_streams(id) on delete restrict,
  reporting_period_id uuid not null references reporting_periods(id) on delete restrict,
  raw_data_object_id uuid not null references raw_data_objects(id) on delete restrict,
  schema_version_id uuid references stream_schema_versions(id) on delete restrict,
  status ingestion_run_status not null,
  schema_drift schema_drift_classification not null,
  row_count integer not null check (row_count >= 0),
  column_count integer not null check (column_count > 0),
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create table ingestion_validation_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  ingestion_run_id uuid not null references ingestion_runs(id) on delete restrict,
  severity validation_severity not null,
  code text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index data_sources_org_type_idx on data_sources(organization_id, source_type);
create index data_streams_org_source_idx on data_streams(organization_id, data_source_id);
create index stream_schema_versions_stream_idx on stream_schema_versions(organization_id, data_stream_id);
create index reporting_periods_stream_idx on reporting_periods(organization_id, data_stream_id, period_start);
create index raw_data_objects_org_status_idx on raw_data_objects(organization_id, status);
create index ingestion_runs_stream_period_idx on ingestion_runs(organization_id, data_stream_id, reporting_period_id);
create index ingestion_validation_results_run_idx on ingestion_validation_results(organization_id, ingestion_run_id);

alter table data_sources enable row level security;
alter table data_streams enable row level security;
alter table stream_schema_versions enable row level security;
alter table reporting_periods enable row level security;
alter table raw_data_objects enable row level security;
alter table ingestion_runs enable row level security;
alter table ingestion_validation_results enable row level security;

create policy data_sources_rls on data_sources
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy data_streams_rls on data_streams
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy stream_schema_versions_rls on stream_schema_versions
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy reporting_periods_rls on reporting_periods
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy raw_data_objects_rls on raw_data_objects
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy ingestion_runs_rls on ingestion_runs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy ingestion_validation_results_rls on ingestion_validation_results
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
