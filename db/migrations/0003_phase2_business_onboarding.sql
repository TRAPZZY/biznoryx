begin;

create type onboarding_status as enum ('draft', 'in_review', 'completed');
create type fact_kind as enum ('confirmed_fact', 'inferred_fact');
create type business_model_entry_type as enum ('product_service', 'location', 'customer_segment', 'channel');
create type kpi_value_type as enum ('money', 'number', 'percent', 'ratio');
create type goal_status as enum ('active', 'paused', 'completed', 'cancelled');

create table business_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  legal_name text not null,
  trading_name text,
  industry text not null,
  business_model text not null,
  primary_currency char(3) not null,
  fiscal_year_start_month integer not null check (fiscal_year_start_month between 1 and 12),
  timezone text not null,
  status onboarding_status not null default 'draft',
  version integer not null default 1 check (version > 0),
  completed_at timestamptz,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table business_model_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  entry_type business_model_entry_type not null,
  name text not null,
  description text,
  status text not null default 'active',
  provenance jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, business_profile_id, entry_type, name)
);

create table business_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  fact_kind fact_kind not null,
  subject text not null,
  predicate text not null,
  value text not null,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source text not null,
  provenance jsonb not null default '{}'::jsonb,
  valid_from date,
  valid_until date,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create table business_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  term text not null,
  definition text not null,
  source text not null,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, business_profile_id, term)
);

create table business_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  name text not null,
  target_metric text not null,
  target_value numeric not null,
  target_period text not null,
  status goal_status not null default 'active',
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now()
);

create table kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  business_profile_id uuid not null references business_profiles(id) on delete restrict,
  name text not null,
  description text not null,
  value_type kpi_value_type not null,
  calculation_method text not null,
  source_hint text not null,
  version integer not null default 1 check (version > 0),
  active_from date not null default current_date,
  active_until date,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, business_profile_id, name, version)
);

create index business_profiles_org_status_idx on business_profiles(organization_id, status);
create index business_model_entries_org_profile_idx on business_model_entries(organization_id, business_profile_id);
create index business_facts_org_profile_kind_idx on business_facts(organization_id, business_profile_id, fact_kind);
create index business_terms_org_profile_idx on business_terms(organization_id, business_profile_id);
create index business_goals_org_profile_status_idx on business_goals(organization_id, business_profile_id, status);
create index kpi_definitions_org_profile_idx on kpi_definitions(organization_id, business_profile_id);

alter table business_profiles enable row level security;
alter table business_model_entries enable row level security;
alter table business_facts enable row level security;
alter table business_terms enable row level security;
alter table business_goals enable row level security;
alter table kpi_definitions enable row level security;

create policy business_profiles_rls on business_profiles
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy business_model_entries_rls on business_model_entries
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy business_facts_rls on business_facts
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy business_terms_rls on business_terms
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy business_goals_rls on business_goals
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy kpi_definitions_rls on kpi_definitions
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

commit;
