begin;

create table verified_metric_definitions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  data_stream_id uuid not null
    references data_streams(id)
    on delete cascade,

  metric_key text not null,

  label text not null,

  source_column text not null,

  aggregation text not null
    check (
      aggregation in (
        'sum',
        'count',
        'average',
        'min',
        'max'
      )
    ),

  unit text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    data_stream_id,
    metric_key
  )
);

create index verified_metric_definitions_tenant_idx
  on verified_metric_definitions (
    organization_id,
    data_stream_id,
    metric_key
  );

create table verified_metric_points (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  metric_definition_id uuid not null
    references verified_metric_definitions(id)
    on delete cascade,

  data_stream_id uuid not null
    references data_streams(id)
    on delete cascade,

  reporting_period_id uuid not null
    references reporting_periods(id)
    on delete cascade,

  ingestion_run_id uuid not null
    references ingestion_runs(id)
    on delete cascade,

  raw_data_object_id uuid not null
    references raw_data_objects(id)
    on delete cascade,

  value_numeric numeric(38, 10) not null,

  contributing_row_count integer not null
    check (
      contributing_row_count >= 0
    ),

  source_row_count integer not null
    check (
      source_row_count >= 0
    ),

  evidence jsonb not null
    check (
      jsonb_typeof(evidence) = 'object'
    ),

  created_at timestamptz not null default now(),

  unique (
    organization_id,
    metric_definition_id,
    ingestion_run_id
  )
);

create index verified_metric_points_tenant_idx
  on verified_metric_points (
    organization_id,
    data_stream_id,
    reporting_period_id
  );

create index verified_metric_points_ingestion_idx
  on verified_metric_points (
    organization_id,
    ingestion_run_id
  );

create index verified_metric_points_definition_idx
  on verified_metric_points (
    organization_id,
    metric_definition_id,
    created_at desc
  );

alter table verified_metric_definitions
  enable row level security;

alter table verified_metric_definitions
  force row level security;

alter table verified_metric_points
  enable row level security;

alter table verified_metric_points
  force row level security;

create policy verified_metric_definitions_tenant_policy
on verified_metric_definitions
using (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
)
with check (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
);

commit;

create policy verified_metric_points_tenant_policy
on verified_metric_points
using (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
)
with check (
  organization_id =
    nullif(
      current_setting(
        'app.current_organization_id',
        true
      ),
      ''
    )::uuid
);
