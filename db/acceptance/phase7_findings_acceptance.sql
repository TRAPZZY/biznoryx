set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000071', 'phase7-owner@example.com', 'Phase 7 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000072', 'phase7-other@example.com', 'Phase 7 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000071', 'Phase 7 Acme', 'phase7-acme', '00000000-0000-4000-8000-000000000071'),
  ('10000000-0000-4000-8000-000000000072', 'Phase 7 Beta', 'phase7-beta', '00000000-0000-4000-8000-000000000072');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-000000000071', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000072', 'owner', 'active');

insert into business_profiles (id, organization_id, legal_name, industry, business_model, primary_currency, fiscal_year_start_month, timezone, status, created_by_user_id, updated_by_user_id)
values ('30000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'Phase 7 Acme Ltd', 'Retail', 'Retail sales', 'USD', 1, 'America/New_York', 'completed', '00000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-000000000071');

insert into kpi_definitions (id, organization_id, business_profile_id, name, description, value_type, calculation_method, source_hint, created_by_user_id)
values ('39000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '30000000-0000-4000-8000-000000000071', 'Revenue', 'Total net sales', 'money', 'sum mapped revenue field', 'monthly sales stream', '00000000-0000-4000-8000-000000000071');

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'Phase 7 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000071');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000071');

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values
  ('43000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', '2027-01-01', '2027-01-31', 'January 2027'),
  ('43000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', '2027-02-01', '2027-02-28', 'February 2027');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values ('42000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', 1, 'phase7-schema', '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb, '00000000-0000-4000-8000-000000000071');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values
  ('44000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'org/phase7/raw/january.csv', 'january.csv', 'text/csv', 128, 'phase7-checksum-jan', 'accepted', '00000000-0000-4000-8000-000000000071'),
  ('44000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', 'org/phase7/raw/february.csv', 'february.csv', 'text/csv', 128, 'phase7-checksum-feb', 'accepted', '00000000-0000-4000-8000-000000000071');

insert into ingestion_runs (id, organization_id, data_source_id, data_stream_id, reporting_period_id, raw_data_object_id, schema_version_id, status, schema_drift, row_count, column_count, created_by_user_id)
values
  ('45000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', '43000000-0000-4000-8000-000000000071', '44000000-0000-4000-8000-000000000071', '42000000-0000-4000-8000-000000000071', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000071'),
  ('45000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', '43000000-0000-4000-8000-000000000072', '44000000-0000-4000-8000-000000000072', '42000000-0000-4000-8000-000000000071', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000071');

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id)
values ('50000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '41000000-0000-4000-8000-000000000071', '42000000-0000-4000-8000-000000000071', 1, 'active', '00000000-0000-4000-8000-000000000071');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '39000000-0000-4000-8000-000000000071', '50000000-0000-4000-8000-000000000071', 'sum', 'revenue', '00000000-0000-4000-8000-000000000071');

insert into verified_metric_runs (id, organization_id, kpi_definition_id, metric_calculation_spec_id, ingestion_run_id, reporting_period_id, status, value, unit, evidence, created_by_user_id)
values
  ('52000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', '39000000-0000-4000-8000-000000000071', '51000000-0000-4000-8000-000000000071', '45000000-0000-4000-8000-000000000071', '43000000-0000-4000-8000-000000000071', 'calculated', 100, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000071'),
  ('52000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000071', '39000000-0000-4000-8000-000000000071', '51000000-0000-4000-8000-000000000071', '45000000-0000-4000-8000-000000000072', '43000000-0000-4000-8000-000000000072', 'calculated', 125, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000071');

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
  '70000000-0000-4000-8000-000000000071',
  '10000000-0000-4000-8000-000000000071',
  '39000000-0000-4000-8000-000000000071',
  '52000000-0000-4000-8000-000000000072',
  '52000000-0000-4000-8000-000000000071',
  '43000000-0000-4000-8000-000000000072',
  '43000000-0000-4000-8000-000000000071',
  'calculated',
  125,
  100,
  25,
  25,
  'up',
  '{"periodComparison":"ready"}'::jsonb,
  '{"currentMetricRunId":"52000000-0000-4000-8000-000000000072","previousMetricRunId":"52000000-0000-4000-8000-000000000071"}'::jsonb,
  '00000000-0000-4000-8000-000000000071'
);

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000071';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000071';

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
  '80000000-0000-4000-8000-000000000071',
  '10000000-0000-4000-8000-000000000071',
  '39000000-0000-4000-8000-000000000071',
  '70000000-0000-4000-8000-000000000071',
  'opportunity',
  'high',
  'Revenue improvement may be repeatable',
  'Revenue improved versus the previous verified period. Treat the driver as a hypothesis until supported by evidence.',
  '{"comparisonId":"70000000-0000-4000-8000-000000000071","direction":"up","percentChange":25}'::jsonb,
  '00000000-0000-4000-8000-000000000071'
);

insert into finding_evidence (id, organization_id, finding_id, evidence_type, evidence_id, label, metadata)
values (
  '81000000-0000-4000-8000-000000000071',
  '10000000-0000-4000-8000-000000000071',
  '80000000-0000-4000-8000-000000000071',
  'metric_period_comparison',
  '70000000-0000-4000-8000-000000000071',
  'Revenue verified comparison',
  '{"currentMetricRunId":"52000000-0000-4000-8000-000000000072"}'::jsonb
);

do $$
declare
  visible_findings integer;
  visible_evidence integer;
begin
  select count(*) into visible_findings from performance_findings;
  select count(*) into visible_evidence from finding_evidence;
  if visible_findings <> 1 or visible_evidence <> 1 then
    raise exception 'unexpected finding visibility findings=% evidence=%', visible_findings, visible_evidence;
  end if;
end $$;

do $$
begin
  begin
    insert into performance_findings (
      organization_id,
      kpi_definition_id,
      metric_period_comparison_id,
      kind,
      severity,
      title,
      explanation,
      created_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000072',
      '39000000-0000-4000-8000-000000000071',
      '70000000-0000-4000-8000-000000000071',
      'risk',
      'high',
      'Cross tenant risk',
      'This insert must be rejected by RLS.',
      '00000000-0000-4000-8000-000000000071'
    );
    raise exception 'expected cross-tenant finding insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_findings integer;
begin
  select count(*) into visible_findings from performance_findings;
  if visible_findings <> 0 then
    raise exception 'expected default-deny for performance findings, got %', visible_findings;
  end if;
end $$;

rollback;
