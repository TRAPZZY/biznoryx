begin;

create type forecast_model_kind as enum ('linear_projection');
create type forecast_status as enum ('not_ready', 'calculated');
create type scenario_status as enum ('draft', 'active', 'archived');

create table forecast_models (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  name text not null,
  model_kind forecast_model_kind not null default 'linear_projection',
  minimum_points integer not null default 3 check (minimum_points > 0),
  horizon_periods integer not null default 3 check (horizon_periods > 0),
  status scenario_status not null default 'active',
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table forecast_scenarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  forecast_model_id uuid not null references forecast_models(id) on delete restrict,
  name text not null,
  status scenario_status not null default 'active',
  assumptions jsonb not null default '{}'::jsonb,
  adjustment_percent numeric not null default 0,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table forecast_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  forecast_model_id uuid not null references forecast_models(id) on delete restrict,
  forecast_scenario_id uuid references forecast_scenarios(id) on delete restrict,
  status forecast_status not null,
  horizon_periods integer not null check (horizon_periods > 0),
  points_used integer not null check (points_used >= 0),
  baseline_value numeric,
  slope numeric,
  forecast_values jsonb not null default '[]'::jsonb,
  uncertainty jsonb not null default '{}'::jsonb,
  readiness jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create index forecast_models_org_kpi_idx on forecast_models(organization_id, kpi_definition_id, status);
create index forecast_scenarios_model_idx on forecast_scenarios(organization_id, forecast_model_id, status);
create index forecast_runs_model_idx on forecast_runs(organization_id, forecast_model_id, created_at desc);

alter table forecast_models enable row level security;
alter table forecast_scenarios enable row level security;
alter table forecast_runs enable row level security;

create policy forecast_models_rls on forecast_models
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy forecast_scenarios_rls on forecast_scenarios
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy forecast_runs_rls on forecast_runs
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
