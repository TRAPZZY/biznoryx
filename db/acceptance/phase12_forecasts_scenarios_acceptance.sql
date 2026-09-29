set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000121', 'phase12-owner@example.com', 'Phase 12 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000122', 'phase12-other@example.com', 'Phase 12 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000121', 'Phase 12 Acme', 'phase12-acme', '00000000-0000-4000-8000-000000000121'),
  ('10000000-0000-4000-8000-000000000122', 'Phase 12 Beta', 'phase12-beta', '00000000-0000-4000-8000-000000000122');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000121', '10000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000121', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000122', '10000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-000000000122', 'owner', 'active');

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
  '30000000-0000-4000-8000-000000000121',
  '10000000-0000-4000-8000-000000000121',
  'Phase 12 Acme Ltd',
  'Phase 12 Acme',
  'Retail',
  'Retail sales',
  'USD',
  1,
  'America/New_York',
  'completed',
  '00000000-0000-4000-8000-000000000121',
  '00000000-0000-4000-8000-000000000121'
);

insert into kpi_definitions (
  id,
  organization_id,
  business_profile_id,
  name,
  description,
  value_type,
  calculation_method,
  source_hint,
  created_by_user_id
) values (
  '40000000-0000-4000-8000-000000000121',
  '10000000-0000-4000-8000-000000000121',
  '30000000-0000-4000-8000-000000000121',
  'Revenue',
  'Total net sales',
  'money',
  'sum revenue',
  'monthly sales',
  '00000000-0000-4000-8000-000000000121'
);

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000121';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000121';

insert into forecast_models (
  id,
  organization_id,
  kpi_definition_id,
  name,
  minimum_points,
  horizon_periods,
  created_by_user_id,
  updated_by_user_id
) values (
  '50000000-0000-4000-8000-000000000121',
  '10000000-0000-4000-8000-000000000121',
  '40000000-0000-4000-8000-000000000121',
  'Revenue projection',
  3,
  3,
  '00000000-0000-4000-8000-000000000121',
  '00000000-0000-4000-8000-000000000121'
);

insert into forecast_scenarios (
  id,
  organization_id,
  forecast_model_id,
  name,
  assumptions,
  adjustment_percent,
  created_by_user_id,
  updated_by_user_id
) values (
  '60000000-0000-4000-8000-000000000121',
  '10000000-0000-4000-8000-000000000121',
  '50000000-0000-4000-8000-000000000121',
  'Expansion case',
  '{"assumption":"more store traffic"}'::jsonb,
  10,
  '00000000-0000-4000-8000-000000000121',
  '00000000-0000-4000-8000-000000000121'
);

insert into forecast_runs (
  id,
  organization_id,
  forecast_model_id,
  forecast_scenario_id,
  status,
  horizon_periods,
  points_used,
  baseline_value,
  slope,
  forecast_values,
  uncertainty,
  readiness,
  evidence,
  created_by_user_id
) values (
  '70000000-0000-4000-8000-000000000121',
  '10000000-0000-4000-8000-000000000121',
  '50000000-0000-4000-8000-000000000121',
  '60000000-0000-4000-8000-000000000121',
  'calculated',
  3,
  3,
  120,
  10,
  '[{"periodOffset":1,"value":143},{"periodOffset":2,"value":154},{"periodOffset":3,"value":165}]'::jsonb,
  '{"meanAbsoluteError":0,"adjustmentPercent":10}'::jsonb,
  '{"requiredPoints":3,"actualPoints":3}'::jsonb,
  '{"method":"linear_projection"}'::jsonb,
  '00000000-0000-4000-8000-000000000121'
);

do $$
declare
  visible_models integer;
  visible_scenarios integer;
  visible_runs integer;
begin
  select count(*) into visible_models from forecast_models;
  select count(*) into visible_scenarios from forecast_scenarios;
  select count(*) into visible_runs from forecast_runs;
  if visible_models <> 1 or visible_scenarios <> 1 or visible_runs <> 1 then
    raise exception 'unexpected forecast visibility models=% scenarios=% runs=%', visible_models, visible_scenarios, visible_runs;
  end if;
end $$;

do $$
begin
  begin
    insert into forecast_models (
      organization_id,
      kpi_definition_id,
      name,
      created_by_user_id,
      updated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000122',
      '40000000-0000-4000-8000-000000000121',
      'Cross tenant forecast',
      '00000000-0000-4000-8000-000000000121',
      '00000000-0000-4000-8000-000000000121'
    );
    raise exception 'expected cross-tenant forecast model insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_models integer;
begin
  select count(*) into visible_models from forecast_models;
  if visible_models <> 0 then
    raise exception 'expected default-deny for forecast models, got %', visible_models;
  end if;
end $$;

rollback;
