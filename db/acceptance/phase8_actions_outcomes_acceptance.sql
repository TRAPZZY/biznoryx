set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000081', 'phase8-owner@example.com', 'Phase 8 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000082', 'phase8-other@example.com', 'Phase 8 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000081', 'Phase 8 Acme', 'phase8-acme', '00000000-0000-4000-8000-000000000081'),
  ('10000000-0000-4000-8000-000000000082', 'Phase 8 Beta', 'phase8-beta', '00000000-0000-4000-8000-000000000082');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000081', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-000000000082', 'owner', 'active');

insert into business_profiles (id, organization_id, legal_name, industry, business_model, primary_currency, fiscal_year_start_month, timezone, status, created_by_user_id, updated_by_user_id)
values ('30000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', 'Phase 8 Acme Ltd', 'Retail', 'Retail sales', 'USD', 1, 'America/New_York', 'completed', '00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000081');

insert into kpi_definitions (id, organization_id, business_profile_id, name, description, value_type, calculation_method, source_hint, created_by_user_id)
values ('39000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '30000000-0000-4000-8000-000000000081', 'Revenue', 'Total net sales', 'money', 'sum mapped revenue field', 'monthly sales stream', '00000000-0000-4000-8000-000000000081');

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', 'Phase 8 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000081');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000081', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000081');

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values
  ('43000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', '2027-01-01', '2027-01-31', 'January 2027'),
  ('43000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', '2027-02-01', '2027-02-28', 'February 2027');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values ('42000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', 1, 'phase8-schema', '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb, '00000000-0000-4000-8000-000000000081');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values
  ('44000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', 'org/phase8/raw/january.csv', 'january.csv', 'text/csv', 128, 'phase8-checksum-jan', 'accepted', '00000000-0000-4000-8000-000000000081'),
  ('44000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000081', 'org/phase8/raw/february.csv', 'february.csv', 'text/csv', 128, 'phase8-checksum-feb', 'accepted', '00000000-0000-4000-8000-000000000081');

set local app.current_organization_id = '10000000-0000-4000-8000-000000000081';

insert into ingestion_runs (id, organization_id, data_source_id, data_stream_id, reporting_period_id, raw_data_object_id, schema_version_id, status, schema_drift, row_count, column_count, created_by_user_id)
values
  ('45000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', '43000000-0000-4000-8000-000000000081', '44000000-0000-4000-8000-000000000081', '42000000-0000-4000-8000-000000000081', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000081'),
  ('45000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', '43000000-0000-4000-8000-000000000082', '44000000-0000-4000-8000-000000000082', '42000000-0000-4000-8000-000000000081', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000081');

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id)
values ('50000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '41000000-0000-4000-8000-000000000081', '42000000-0000-4000-8000-000000000081', 1, 'active', '00000000-0000-4000-8000-000000000081');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '39000000-0000-4000-8000-000000000081', '50000000-0000-4000-8000-000000000081', 'sum', 'revenue', '00000000-0000-4000-8000-000000000081');

insert into verified_metric_runs (id, organization_id, kpi_definition_id, metric_calculation_spec_id, ingestion_run_id, reporting_period_id, status, value, unit, evidence, created_by_user_id)
values
  ('52000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000081', '39000000-0000-4000-8000-000000000081', '51000000-0000-4000-8000-000000000081', '45000000-0000-4000-8000-000000000081', '43000000-0000-4000-8000-000000000081', 'calculated', 100, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000081'),
  ('52000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000081', '39000000-0000-4000-8000-000000000081', '51000000-0000-4000-8000-000000000081', '45000000-0000-4000-8000-000000000082', '43000000-0000-4000-8000-000000000082', 'calculated', 125, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000081');

insert into metric_period_comparisons (
  id,
  organization_id,
  kpi_definition_id,
  current_metric_run_id,
  previous_metric_run_id,
  current_reporting_period_id,
  previous_reporting_period_id,
  status,
  current_value,
  previous_value,
  absolute_change,
  percent_change,
  direction,
  readiness,
  evidence,
  created_by_user_id
) values (
  '70000000-0000-4000-8000-000000000081',
  '10000000-0000-4000-8000-000000000081',
  '39000000-0000-4000-8000-000000000081',
  '52000000-0000-4000-8000-000000000082',
  '52000000-0000-4000-8000-000000000081',
  '43000000-0000-4000-8000-000000000082',
  '43000000-0000-4000-8000-000000000081',
  'calculated',
  125,
  100,
  25,
  25,
  'up',
  '{"periodComparison":"ready"}'::jsonb,
  '{"currentMetricRunId":"52000000-0000-4000-8000-000000000082","previousMetricRunId":"52000000-0000-4000-8000-000000000081"}'::jsonb,
  '00000000-0000-4000-8000-000000000081'
);

insert into performance_findings (
  id,
  organization_id,
  kpi_definition_id,
  metric_period_comparison_id,
  kind,
  severity,
  title,
  explanation,
  evidence,
  created_by_user_id
) values (
  '80000000-0000-4000-8000-000000000081',
  '10000000-0000-4000-8000-000000000081',
  '39000000-0000-4000-8000-000000000081',
  '70000000-0000-4000-8000-000000000081',
  'recommendation',
  'medium',
  'Investigate Revenue movement',
  'Treat drivers as hypotheses until supported by evidence.',
  '{"comparisonId":"70000000-0000-4000-8000-000000000081"}'::jsonb,
  '00000000-0000-4000-8000-000000000081'
);

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000081';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000081';

insert into management_actions (
  id,
  organization_id,
  finding_id,
  owner_user_id,
  title,
  description,
  status,
  due_date,
  success_metric_kpi_definition_id,
  created_by_user_id,
  updated_by_user_id
) values (
  '90000000-0000-4000-8000-000000000081',
  '10000000-0000-4000-8000-000000000081',
  '80000000-0000-4000-8000-000000000081',
  '00000000-0000-4000-8000-000000000081',
  'Review revenue drivers',
  'Compare channel mix and campaign timing.',
  'in_progress',
  '2027-03-15',
  '39000000-0000-4000-8000-000000000081',
  '00000000-0000-4000-8000-000000000081',
  '00000000-0000-4000-8000-000000000081'
);

insert into action_outcomes (
  id,
  organization_id,
  management_action_id,
  reporting_period_id,
  verified_metric_run_id,
  assessment,
  baseline_value,
  outcome_value,
  delta_value,
  narrative,
  evidence,
  created_by_user_id
) values (
  '91000000-0000-4000-8000-000000000081',
  '10000000-0000-4000-8000-000000000081',
  '90000000-0000-4000-8000-000000000081',
  '43000000-0000-4000-8000-000000000082',
  '52000000-0000-4000-8000-000000000082',
  'improved',
  100,
  125,
  25,
  'Follow-up revenue improved versus baseline.',
  '{"verifiedMetricRunId":"52000000-0000-4000-8000-000000000082"}'::jsonb,
  '00000000-0000-4000-8000-000000000081'
);

do $$
declare
  visible_actions integer;
  visible_outcomes integer;
begin
  select count(*) into visible_actions from management_actions;
  select count(*) into visible_outcomes from action_outcomes;
  if visible_actions <> 1 or visible_outcomes <> 1 then
    raise exception 'unexpected action visibility actions=% outcomes=%', visible_actions, visible_outcomes;
  end if;
end $$;

do $$
begin
  begin
    insert into management_actions (
      organization_id,
      finding_id,
      owner_user_id,
      title,
      description,
      created_by_user_id,
      updated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000082',
      '80000000-0000-4000-8000-000000000081',
      '00000000-0000-4000-8000-000000000081',
      'Cross tenant action',
      'This insert must be rejected by RLS.',
      '00000000-0000-4000-8000-000000000081',
      '00000000-0000-4000-8000-000000000081'
    );
    raise exception 'expected cross-tenant action insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_actions integer;
begin
  select count(*) into visible_actions from management_actions;
  if visible_actions <> 0 then
    raise exception 'expected default-deny for management actions, got %', visible_actions;
  end if;
end $$;

rollback;
