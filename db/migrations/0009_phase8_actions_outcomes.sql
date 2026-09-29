begin;

create type management_action_status as enum ('planned', 'in_progress', 'completed', 'cancelled');
create type action_outcome_assessment as enum ('improved', 'declined', 'unchanged', 'inconclusive');

create table management_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  finding_id uuid not null references performance_findings(id) on delete restrict,
  owner_user_id uuid not null references app_users(id),
  title text not null,
  description text not null,
  status management_action_status not null default 'planned',
  due_date date,
  success_metric_kpi_definition_id uuid references kpi_definitions(id) on delete restrict,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table action_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  management_action_id uuid not null references management_actions(id) on delete restrict,
  reporting_period_id uuid references reporting_periods(id) on delete restrict,
  verified_metric_run_id uuid references verified_metric_runs(id) on delete restrict,
  assessment action_outcome_assessment not null,
  baseline_value numeric,
  outcome_value numeric,
  delta_value numeric,
  narrative text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create index management_actions_org_status_idx on management_actions(organization_id, status, due_date);
create index management_actions_finding_idx on management_actions(organization_id, finding_id);
create index action_outcomes_action_idx on action_outcomes(organization_id, management_action_id);

alter table management_actions enable row level security;
alter table action_outcomes enable row level security;

create policy management_actions_rls on management_actions
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy action_outcomes_rls on action_outcomes
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
