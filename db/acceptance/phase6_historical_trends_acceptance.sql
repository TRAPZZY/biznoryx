set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000061', 'phase6-owner@example.com', 'Phase 6 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000062', 'phase6-other@example.com', 'Phase 6 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000061', 'Phase 6 Acme', 'phase6-acme', '00000000-0000-4000-8000-000000000061'),
  ('10000000-0000-4000-8000-000000000062', 'Phase 6 Beta', 'phase6-beta', '00000000-0000-4000-8000-000000000062');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000061', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000062', 'owner', 'active');

insert into business_profiles (id, organization_id, legal_name, industry, business_model, primary_currency, fiscal_year_start_month, timezone, status, created_by_user_id, updated_by_user_id)
values ('30000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', 'Phase 6 Acme Ltd', 'Retail', 'Retail sales', 'USD', 1, 'America/New_York', 'completed', '00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000061');

insert into kpi_definitions (id, organization_id, business_profile_id, name, description, value_type, calculation_method, source_hint, created_by_user_id)
values ('39000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '30000000-0000-4000-8000-000000000061', 'Revenue', 'Total net sales', 'money', 'sum mapped revenue field', 'monthly sales stream', '00000000-0000-4000-8000-000000000061');

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', 'Phase 6 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000061');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000061', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000061');

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values
  ('43000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', '2027-01-01', '2027-01-31', 'January 2027'),
  ('43000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', '2027-02-01', '2027-02-28', 'February 2027');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values ('42000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', 1, 'phase6-schema', '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb, '00000000-0000-4000-8000-000000000061');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values
  ('44000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', 'org/phase6/raw/january.csv', 'january.csv', 'text/csv', 128, 'phase6-checksum-jan', 'accepted', '00000000-0000-4000-8000-000000000061'),
  ('44000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000061', 'org/phase6/raw/february.csv', 'february.csv', 'text/csv', 128, 'phase6-checksum-feb', 'accepted', '00000000-0000-4000-8000-000000000061');

set local app.current_organization_id = '10000000-0000-4000-8000-000000000061';

insert into ingestion_runs (id, organization_id, data_source_id, data_stream_id, reporting_period_id, raw_data_object_id, schema_version_id, status, schema_drift, row_count, column_count, created_by_user_id)
values
  ('45000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', '43000000-0000-4000-8000-000000000061', '44000000-0000-4000-8000-000000000061', '42000000-0000-4000-8000-000000000061', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000061'),
  ('45000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', '43000000-0000-4000-8000-000000000062', '44000000-0000-4000-8000-000000000062', '42000000-0000-4000-8000-000000000061', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000061');

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id)
values ('50000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000061', '42000000-0000-4000-8000-000000000061', 1, 'active', '00000000-0000-4000-8000-000000000061');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '39000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000061', 'sum', 'revenue', '00000000-0000-4000-8000-000000000061');

insert into verified_metric_runs (id, organization_id, kpi_definition_id, metric_calculation_spec_id, ingestion_run_id, reporting_period_id, status, value, unit, evidence, created_by_user_id)
values
  ('52000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '39000000-0000-4000-8000-000000000061', '51000000-0000-4000-8000-000000000061', '45000000-0000-4000-8000-000000000061', '43000000-0000-4000-8000-000000000061', 'calculated', 100, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000061'),
  ('52000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000061', '39000000-0000-4000-8000-000000000061', '51000000-0000-4000-8000-000000000061', '45000000-0000-4000-8000-000000000062', '43000000-0000-4000-8000-000000000062', 'calculated', 125, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000061');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000061';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000061';

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
  '70000000-0000-4000-8000-000000000061',
  '10000000-0000-4000-8000-000000000061',
  '39000000-0000-4000-8000-000000000061',
  '52000000-0000-4000-8000-000000000062',
  '52000000-0000-4000-8000-000000000061',
  '43000000-0000-4000-8000-000000000062',
  '43000000-0000-4000-8000-000000000061',
  'calculated',
  125,
  100,
  25,
  25,
  'up',
  '{"periodComparison":"ready"}'::jsonb,
  '{"currentMetricRunId":"52000000-0000-4000-8000-000000000062","previousMetricRunId":"52000000-0000-4000-8000-000000000061"}'::jsonb,
  '00000000-0000-4000-8000-000000000061'
);

insert into metric_trend_summaries (
  organization_id,
  kpi_definition_id,
  status,
  points,
  direction,
  latest_metric_run_id,
  summary,
  evidence,
  created_by_user_id
) values (
  '10000000-0000-4000-8000-000000000061',
  '39000000-0000-4000-8000-000000000061',
  'calculated',
  2,
  'up',
  '52000000-0000-4000-8000-000000000062',
  'Revenue is up across 2 verified periods.',
  '{"absoluteChange":25,"percentChange":25}'::jsonb,
  '00000000-0000-4000-8000-000000000061'
);

do $$
declare
  visible_comparisons integer;
  visible_summaries integer;
begin
  select count(*) into visible_comparisons from metric_period_comparisons;
  select count(*) into visible_summaries from metric_trend_summaries;
  if visible_comparisons <> 1 or visible_summaries <> 1 then
    raise exception 'unexpected trend visibility comparisons=% summaries=%', visible_comparisons, visible_summaries;
  end if;
end $$;

do $$
begin
  begin
    insert into metric_period_comparisons (
      organization_id,
      kpi_definition_id,
      current_metric_run_id,
      current_reporting_period_id,
      status,
      direction,
      created_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000062',
      '39000000-0000-4000-8000-000000000061',
      '52000000-0000-4000-8000-000000000062',
      '43000000-0000-4000-8000-000000000062',
      'not_ready',
      'unknown',
      '00000000-0000-4000-8000-000000000061'
    );
    raise exception 'expected cross-tenant comparison insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_comparisons integer;
begin
  select count(*) into visible_comparisons from metric_period_comparisons;
  if visible_comparisons <> 0 then
    raise exception 'expected default-deny for metric comparisons, got %', visible_comparisons;
  end if;
end $$;

rollback;
