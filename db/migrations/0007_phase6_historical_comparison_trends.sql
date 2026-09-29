begin;

create type comparison_status as enum ('calculated', 'not_ready');
create type trend_direction as enum ('up', 'down', 'flat', 'unknown');

create table metric_period_comparisons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  current_metric_run_id uuid not null references verified_metric_runs(id) on delete restrict,
  previous_metric_run_id uuid references verified_metric_runs(id) on delete restrict,
  current_reporting_period_id uuid not null references reporting_periods(id) on delete restrict,
  previous_reporting_period_id uuid references reporting_periods(id) on delete restrict,
  status comparison_status not null,
  current_value numeric,
  previous_value numeric,
  absolute_change numeric,
  percent_change numeric,
  direction trend_direction not null,
  readiness jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, kpi_definition_id, current_metric_run_id)
);

create table metric_trend_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  status comparison_status not null,
  points integer not null check (points >= 0),
  direction trend_direction not null,
  latest_metric_run_id uuid references verified_metric_runs(id) on delete restrict,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create index metric_period_comparisons_org_kpi_idx on metric_period_comparisons(organization_id, kpi_definition_id, created_at);
create index metric_trend_summaries_org_kpi_idx on metric_trend_summaries(organization_id, kpi_definition_id, created_at);

alter table metric_period_comparisons enable row level security;
alter table metric_trend_summaries enable row level security;

create policy metric_period_comparisons_rls on metric_period_comparisons
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy metric_trend_summaries_rls on metric_trend_summaries
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
