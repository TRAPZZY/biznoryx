begin;

create type dashboard_snapshot_status as enum ('generated', 'stale');

create table dashboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  reporting_period_id uuid references reporting_periods(id) on delete restrict,
  status dashboard_snapshot_status not null,
  generated_by_user_id uuid not null references app_users(id),
  generated_at timestamptz not null default now(),
  summary jsonb not null,
  data_health jsonb not null,
  evidence jsonb not null default '[]'::jsonb
);

create table dashboard_snapshot_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  dashboard_snapshot_id uuid not null references dashboard_snapshots(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  verified_metric_run_id uuid references verified_metric_runs(id) on delete restrict,
  label text not null,
  value numeric,
  unit text not null,
  status text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index dashboard_snapshots_org_period_idx on dashboard_snapshots(organization_id, reporting_period_id, generated_at);
create index dashboard_snapshot_metrics_snapshot_idx on dashboard_snapshot_metrics(organization_id, dashboard_snapshot_id);

alter table dashboard_snapshots enable row level security;
alter table dashboard_snapshot_metrics enable row level security;

create policy dashboard_snapshots_rls on dashboard_snapshots
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy dashboard_snapshot_metrics_rls on dashboard_snapshot_metrics
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
