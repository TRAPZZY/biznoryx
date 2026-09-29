begin;

create table verified_metric_comparisons (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  metric_definition_id uuid not null
    references verified_metric_definitions(id)
    on delete cascade,

  current_metric_point_id uuid not null
    references verified_metric_points(id)
    on delete cascade,

  previous_metric_point_id uuid
    references verified_metric_points(id)
    on delete cascade,

  current_reporting_period_id uuid not null
    references reporting_periods(id)
    on delete cascade,

  previous_reporting_period_id uuid
    references reporting_periods(id)
    on delete cascade,

  status text not null
    check (
      status in (
        'not_ready',
        'ready'
      )
    ),

  direction text not null
    check (
      direction in (
        'not_ready',
        'up',
        'down',
        'flat'
      )
    ),

  previous_value_numeric numeric(38, 10),

  current_value_numeric numeric(38, 10) not null,

  absolute_change_numeric numeric(38, 10),

  percent_change_numeric numeric(38, 10),

  evidence jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(evidence) = 'object'
    ),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    metric_definition_id,
    current_metric_point_id
  ),

  check (
    (
      status = 'not_ready'
      and direction = 'not_ready'
      and previous_metric_point_id is null
      and previous_reporting_period_id is null
      and previous_value_numeric is null
      and absolute_change_numeric is null
      and percent_change_numeric is null
    )
    or
    (
      status = 'ready'
      and direction in (
        'up',
        'down',
        'flat'
      )
      and previous_metric_point_id is not null
      and previous_reporting_period_id is not null
      and previous_value_numeric is not null
      and absolute_change_numeric is not null
    )
  )
);

create index verified_metric_comparisons_tenant_idx
  on verified_metric_comparisons (
    organization_id,
    metric_definition_id,
    updated_at desc
  );

create index verified_metric_comparisons_current_period_idx
  on verified_metric_comparisons (
    organization_id,
    current_reporting_period_id
  );

create index verified_metric_comparisons_status_idx
  on verified_metric_comparisons (
    organization_id,
    status,
    direction
  );

alter table verified_metric_comparisons
  enable row level security;

alter table verified_metric_comparisons
  force row level security;

create policy verified_metric_comparisons_tenant_policy
on verified_metric_comparisons
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
