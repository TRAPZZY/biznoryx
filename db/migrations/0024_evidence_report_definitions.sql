begin;

create table evidence_report_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  series_key text not null check (length(series_key) between 1 and 180),
  source_column text not null check (length(source_column) between 1 and 160),
  version integer not null check (version > 0),
  label text not null check (length(label) between 1 and 120),
  unit text not null check (unit in ('currency', 'number')),
  polarity text not null check (polarity in ('higher', 'lower', 'neutral')),
  materiality_percent numeric(6, 3) not null check (materiality_percent between 0.1 and 100),
  approved_by_user_id uuid not null references app_users(id),
  approved_at timestamptz not null default now(),
  unique (organization_id, series_key, source_column, version)
);

alter table evidence_report_definitions enable row level security;
alter table evidence_report_definitions force row level security;
create policy evidence_report_definitions_tenant_policy on evidence_report_definitions
using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
