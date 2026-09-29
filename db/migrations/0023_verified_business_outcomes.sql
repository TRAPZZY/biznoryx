begin;

create table verified_business_outcomes (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  business_action_id uuid not null
    references verified_business_actions(id)
    on delete cascade,

  metric_definition_id uuid not null
    references verified_metric_definitions(id)
    on delete cascade,

  baseline_metric_point_id uuid not null
    references verified_metric_points(id)
    on delete restrict,

  later_metric_point_id uuid not null
    references verified_metric_points(id)
    on delete restrict,

  baseline_reporting_period_id uuid not null
    references reporting_periods(id)
    on delete restrict,

  later_reporting_period_id uuid not null
    references reporting_periods(id)
    on delete restrict,

  status text not null
    check (
      status in (
        'improved',
        'declined',
        'unchanged'
      )
    ),

  baseline_value_numeric numeric(38, 10) not null,

  later_value_numeric numeric(38, 10) not null,

  absolute_change_numeric numeric(38, 10) not null,

  percent_change_numeric numeric(38, 10),

  evidence jsonb not null
    check (
      jsonb_typeof(evidence) = 'object'
    ),

  assessed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    business_action_id,
    later_metric_point_id
  ),

  check (
    baseline_metric_point_id <> later_metric_point_id
  ),

  check (
    baseline_reporting_period_id <> later_reporting_period_id
  )
);

create index verified_business_outcomes_action_idx
  on verified_business_outcomes (
    organization_id,
    business_action_id,
    assessed_at desc
  );

create index verified_business_outcomes_metric_idx
  on verified_business_outcomes (
    organization_id,
    metric_definition_id,
    later_reporting_period_id
  );

create index verified_business_outcomes_status_idx
  on verified_business_outcomes (
    organization_id,
    status,
    updated_at desc
  );

alter table verified_business_outcomes
  enable row level security;

alter table verified_business_outcomes
  force row level security;

create policy verified_business_outcomes_tenant_policy
on verified_business_outcomes
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
