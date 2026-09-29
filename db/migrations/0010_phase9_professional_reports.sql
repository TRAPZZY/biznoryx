begin;

create type professional_report_status as enum ('draft', 'generated', 'archived');
create type professional_report_section_kind as enum (
  'executive_summary',
  'kpi_scorecard',
  'historical_trends',
  'findings',
  'actions',
  'outcomes',
  'data_health',
  'evidence_appendix'
);

create table professional_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  reporting_period_id uuid references reporting_periods(id) on delete restrict,
  title text not null,
  status professional_report_status not null default 'generated',
  summary text not null,
  generated_by_user_id uuid not null references app_users(id),
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table professional_report_sections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  professional_report_id uuid not null references professional_reports(id) on delete restrict,
  section_order integer not null,
  kind professional_report_section_kind not null,
  heading text not null,
  body text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (professional_report_id, section_order)
);

create index professional_reports_org_generated_idx on professional_reports(organization_id, generated_at desc);
create index professional_report_sections_report_idx on professional_report_sections(organization_id, professional_report_id, section_order);

alter table professional_reports enable row level security;
alter table professional_report_sections enable row level security;

create policy professional_reports_rls on professional_reports
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy professional_report_sections_rls on professional_report_sections
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
