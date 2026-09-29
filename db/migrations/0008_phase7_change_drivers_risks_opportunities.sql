begin;

create type finding_kind as enum ('statistical_signal', 'risk', 'opportunity', 'recommendation');
create type finding_status as enum ('open', 'accepted', 'dismissed', 'resolved');
create type finding_severity as enum ('low', 'medium', 'high');

create table performance_findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  kpi_definition_id uuid not null references kpi_definitions(id) on delete restrict,
  metric_period_comparison_id uuid references metric_period_comparisons(id) on delete restrict,
  kind finding_kind not null,
  severity finding_severity not null,
  status finding_status not null default 'open',
  title text not null,
  explanation text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create table finding_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  finding_id uuid not null references performance_findings(id) on delete restrict,
  evidence_type text not null,
  evidence_id uuid,
  label text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index performance_findings_org_kind_idx on performance_findings(organization_id, kind, status);
create index finding_evidence_finding_idx on finding_evidence(organization_id, finding_id);

alter table performance_findings enable row level security;
alter table finding_evidence enable row level security;

create policy performance_findings_rls on performance_findings
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy finding_evidence_rls on finding_evidence
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
