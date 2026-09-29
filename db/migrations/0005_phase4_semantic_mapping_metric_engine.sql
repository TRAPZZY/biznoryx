begin;

create type semantic_mapping_status as enum ('draft', 'active', 'retired');
create type semantic_field_type as enum ('date', 'dimension', 'measure', 'currency', 'identifier');
create type metric_operation as enum ('sum', 'count', 'average');
create type metric_run_status as enum ('calculated', 'rejected');

create table semantic_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null references data_streams(id) on delete restrict,
  schema_version_id uuid not null references stream_schema_versions(id) on delete restrict,
  version integer not null check (version > 0),
  status semantic_mapping_status not null default 'draft',
  created_by_user_id uuid not null references app_users(id),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, data_stream_id, version)
);

create table semantic_mapping_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  semantic_mapping_id uuid not null references semantic_mappings(id) on delete restrict,
  source_column text not null,
  canonical_field text not null,
  field_type semantic_field_type not null,
  required boolean not null default true,
  transform jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, semantic_mapping_id, source_column),
  unique (organization_id, semantic_mapping_id, canonical_field)
);

create table metric_calculation_specs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  semantic_mapping_id uuid not null references semantic_mappings(id) on delete restrict,
  operation metric_operation not null,
  measure_field text,
  filters jsonb not null default '[]'::jsonb,
  group_by jsonb not null default '[]'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, kpi_definition_id, semantic_mapping_id)
);

create table verified_metric_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  metric_calculation_spec_id uuid not null references metric_calculation_specs(id) on delete restrict,
  ingestion_run_id uuid not null references ingestion_runs(id) on delete restrict,
  reporting_period_id uuid not null references reporting_periods(id) on delete restrict,
  status metric_run_status not null,
  value numeric,
  unit text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, kpi_definition_id, ingestion_run_id)
);

create table metric_run_validation_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  verified_metric_run_id uuid not null references verified_metric_runs(id) on delete restrict,
  severity validation_severity not null,
  code text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index semantic_mappings_stream_idx on semantic_mappings(organization_id, data_stream_id, status);
create index semantic_mapping_fields_mapping_idx on semantic_mapping_fields(organization_id, semantic_mapping_id);
create index metric_calculation_specs_org_kpi_idx on metric_calculation_specs(organization_id, kpi_definition_id);
create index verified_metric_runs_org_period_idx on verified_metric_runs(organization_id, reporting_period_id);
create index metric_run_validation_results_run_idx on metric_run_validation_results(organization_id, verified_metric_run_id);

alter table semantic_mappings enable row level security;
alter table semantic_mapping_fields enable row level security;
alter table metric_calculation_specs enable row level security;
alter table verified_metric_runs enable row level security;
alter table metric_run_validation_results enable row level security;

create policy semantic_mappings_rls on semantic_mappings
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy semantic_mapping_fields_rls on semantic_mapping_fields
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy metric_calculation_specs_rls on metric_calculation_specs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy verified_metric_runs_rls on verified_metric_runs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy metric_run_validation_results_rls on metric_run_validation_results
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
