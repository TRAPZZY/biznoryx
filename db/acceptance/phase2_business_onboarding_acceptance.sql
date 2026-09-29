set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000011', 'phase2-owner@example.com', 'Phase 2 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000012', 'phase2-other@example.com', 'Phase 2 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000011', 'Phase 2 Acme', 'phase2-acme', '00000000-0000-4000-8000-000000000011'),
  ('10000000-0000-4000-8000-000000000012', 'Phase 2 Beta', 'phase2-beta', '00000000-0000-4000-8000-000000000012');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000011', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000012', 'owner', 'active');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000011';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000011';

insert into business_profiles (
  id,
  organization_id,
  legal_name,
  trading_name,
  industry,
  business_model,
  primary_currency,
  fiscal_year_start_month,
  timezone,
  status,
  created_by_user_id,
  updated_by_user_id
) values (
  '30000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000011',
  'Phase 2 Acme Ltd',
  'Phase 2 Acme',
  'Specialty retail',
  'Multi-location retail',
  'USD',
  1,
  'America/New_York',
  'draft',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000011'
);

insert into business_model_entries (
  organization_id,
  business_profile_id,
  entry_type,
  name,
  created_by_user_id
) values
  ('10000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000011', 'product_service', 'Core retail products', '00000000-0000-4000-8000-000000000011'),
  ('10000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000011', 'customer_segment', 'Local shoppers', '00000000-0000-4000-8000-000000000011'),
  ('10000000-0000-4000-8000-000000000011', '30000000-0000-4000-8000-000000000011', 'channel', 'Store sales', '00000000-0000-4000-8000-000000000011');

insert into business_facts (
  organization_id,
  business_profile_id,
  fact_kind,
  subject,
  predicate,
  value,
  confidence,
  source,
  created_by_user_id
) values (
  '10000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000011',
  'confirmed_fact',
  'Business',
  'operates_as',
  'Specialty retail group',
  1,
  'owner_onboarding',
  '00000000-0000-4000-8000-000000000011'
);

insert into business_terms (
  organization_id,
  business_profile_id,
  term,
  definition,
  source,
  created_by_user_id
) values (
  '10000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000011',
  'Net sales',
  'Sales after returns and discounts',
  'owner_onboarding',
  '00000000-0000-4000-8000-000000000011'
);

insert into business_goals (
  organization_id,
  business_profile_id,
  name,
  target_metric,
  target_value,
  target_period,
  created_by_user_id
) values (
  '10000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000011',
  'Grow revenue',
  'Revenue',
  12,
  'FY2027',
  '00000000-0000-4000-8000-000000000011'
);

insert into kpi_definitions (
  organization_id,
  business_profile_id,
  name,
  description,
  value_type,
  calculation_method,
  source_hint,
  created_by_user_id
) values (
  '10000000-0000-4000-8000-000000000011',
  '30000000-0000-4000-8000-000000000011',
  'Revenue',
  'Total net sales for the reporting period',
  'money',
  'sum net sales from verified sales data',
  'monthly sales exports',
  '00000000-0000-4000-8000-000000000011'
);

do $$
declare
  visible_profiles integer;
  visible_entries integer;
  visible_facts integer;
  visible_terms integer;
  visible_goals integer;
  visible_kpis integer;
begin
  select count(*) into visible_profiles from business_profiles;
  select count(*) into visible_entries from business_model_entries;
  select count(*) into visible_facts from business_facts;
  select count(*) into visible_terms from business_terms;
  select count(*) into visible_goals from business_goals;
  select count(*) into visible_kpis from kpi_definitions;

  if visible_profiles <> 1 or visible_entries <> 3 or visible_facts <> 1 or visible_terms <> 1 or visible_goals <> 1 or visible_kpis <> 1 then
    raise exception 'unexpected onboarding visibility profile=% entries=% facts=% terms=% goals=% kpis=%',
      visible_profiles, visible_entries, visible_facts, visible_terms, visible_goals, visible_kpis;
  end if;
end $$;

do $$
begin
  begin
    insert into business_profiles (
      organization_id,
      legal_name,
      industry,
      business_model,
      primary_currency,
      fiscal_year_start_month,
      timezone,
      created_by_user_id,
      updated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000012',
      'Cross Tenant Ltd',
      'Services',
      'Professional services',
      'USD',
      1,
      'America/New_York',
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000011'
    );
    raise exception 'expected cross-tenant business profile insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_profiles integer;
begin
  select count(*) into visible_profiles from business_profiles;
  if visible_profiles <> 0 then
    raise exception 'expected default-deny for business profiles, got %', visible_profiles;
  end if;
end $$;

rollback;
