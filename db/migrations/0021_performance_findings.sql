begin;

create table verified_performance_findings (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references organizations(id)
    on delete cascade,

  source_comparison_id uuid not null,

  metric_definition_id uuid not null
    references verified_metric_definitions(id)
    on delete cascade,

  current_reporting_period_id uuid not null
    references reporting_periods(id)
    on delete cascade,

  finding_type text not null
    check (
      finding_type in (
        'signal',
        'risk',
        'opportunity',
        'focus_area'
      )
    ),

  severity text not null
    check (
      severity in (
        'info',
        'low',
        'medium',
        'high'
      )
    ),

  status text not null default 'active'
    check (
      status in (
        'active',
        'accepted',
        'dismissed'
      )
    ),

  title text not null,

  summary text not null,

  evidence jsonb not null
    check (
      jsonb_typeof(evidence) = 'object'
    ),

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  unique (
    organization_id,
    metric_definition_id,
    current_reporting_period_id,
    finding_type
  )
);

create index verified_performance_findings_tenant_type_idx
  on verified_performance_findings (
    organization_id,
    finding_type,
    status,
    updated_at desc
  );

create index verified_performance_findings_metric_period_idx
  on verified_performance_findings (
    organization_id,
    metric_definition_id,
    current_reporting_period_id
  );

create index verified_performance_findings_comparison_idx
  on verified_performance_findings (
    organization_id,
    source_comparison_id
  );

alter table verified_performance_findings
  enable row level security;

alter table verified_performance_findings
  force row level security;

create policy verified_performance_findings_tenant_policy
on verified_performance_findings
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
