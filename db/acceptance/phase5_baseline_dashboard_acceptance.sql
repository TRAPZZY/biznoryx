set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000041', 'phase5-owner@example.com', 'Phase 5 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000042', 'phase5-other@example.com', 'Phase 5 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000041', 'Phase 5 Acme', 'phase5-acme', '00000000-0000-4000-8000-000000000041'),
  ('10000000-0000-4000-8000-000000000042', 'Phase 5 Beta', 'phase5-beta', '00000000-0000-4000-8000-000000000042');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000041', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000042', 'owner', 'active');

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
  '30000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000041',
  'Phase 5 Acme Ltd',
  'Phase 5 Acme',
  'Retail',
  'Retail sales',
  'USD',
  1,
  'America/New_York',
  'completed',
  '00000000-0000-4000-8000-000000000041',
  '00000000-0000-4000-8000-000000000041'
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
  '39000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000041',
  '30000000-0000-4000-8000-000000000041',
  'Revenue',
  'Total net sales',
  'money',
  'sum mapped revenue field',
  'monthly sales stream',
  '00000000-0000-4000-8000-000000000041'
);

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', 'Phase 5 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000041');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000041', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000041');

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values ('43000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '41000000-0000-4000-8000-000000000041', '2027-01-01', '2027-01-31', 'January 2027');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values ('42000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '41000000-0000-4000-8000-000000000041', 1, 'phase5-schema', '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb, '00000000-0000-4000-8000-000000000041');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values ('44000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', 'org/phase5/raw/sales.csv', 'sales.csv', 'text/csv', 128, 'phase5-checksum', 'accepted', '00000000-0000-4000-8000-000000000041');

set local app.current_organization_id = '10000000-0000-4000-8000-000000000041';

insert into ingestion_runs (id, organization_id, data_source_id, data_stream_id, reporting_period_id, raw_data_object_id, schema_version_id, status, schema_drift, row_count, column_count, created_by_user_id)
values ('45000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000041', '41000000-0000-4000-8000-000000000041', '43000000-0000-4000-8000-000000000041', '44000000-0000-4000-8000-000000000041', '42000000-0000-4000-8000-000000000041', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000041');

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id)
values ('50000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '41000000-0000-4000-8000-000000000041', '42000000-0000-4000-8000-000000000041', 1, 'active', '00000000-0000-4000-8000-000000000041');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '39000000-0000-4000-8000-000000000041', '50000000-0000-4000-8000-000000000041', 'sum', 'revenue', '00000000-0000-4000-8000-000000000041');

insert into verified_metric_runs (id, organization_id, kpi_definition_id, metric_calculation_spec_id, ingestion_run_id, reporting_period_id, status, value, unit, evidence, created_by_user_id)
values ('52000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '39000000-0000-4000-8000-000000000041', '51000000-0000-4000-8000-000000000041', '45000000-0000-4000-8000-000000000041', '43000000-0000-4000-8000-000000000041', 'calculated', 150, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000041');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000041';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000041';

insert into dashboard_snapshots (
  id,
  organization_id,
  business_profile_id,
  reporting_period_id,
  status,
  generated_by_user_id,
  summary,
  data_health,
  evidence
) values (
  '60000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000041',
  '30000000-0000-4000-8000-000000000041',
  '43000000-0000-4000-8000-000000000041',
  'generated',
  '00000000-0000-4000-8000-000000000041',
  '{"businessName":"Phase 5 Acme","pulse":"Revenue is 150 money. Data health is healthy.","modules":["Business Pulse","KPI Scoreboard","Data Health"]}'::jsonb,
  '{"status":"healthy","validatedRuns":1,"rejectedRuns":0}'::jsonb,
  '[{"verifiedMetricRunId":"52000000-0000-4000-8000-000000000041"}]'::jsonb
);

insert into dashboard_snapshot_metrics (
  organization_id,
  dashboard_snapshot_id,
  kpi_definition_id,
  verified_metric_run_id,
  label,
  value,
  unit,
  status,
  evidence
) values (
  '10000000-0000-4000-8000-000000000041',
  '60000000-0000-4000-8000-000000000041',
  '39000000-0000-4000-8000-000000000041',
  '52000000-0000-4000-8000-000000000041',
  'Revenue',
  150,
  'money',
  'verified',
  '{"metricRunId":"52000000-0000-4000-8000-000000000041"}'::jsonb
);

do $$
declare
  visible_snapshots integer;
  visible_metrics integer;
begin
  select count(*) into visible_snapshots from dashboard_snapshots;
  select count(*) into visible_metrics from dashboard_snapshot_metrics;
  if visible_snapshots <> 1 or visible_metrics <> 1 then
    raise exception 'unexpected dashboard visibility snapshots=% metrics=%', visible_snapshots, visible_metrics;
  end if;
end $$;

do $$
begin
  begin
    insert into dashboard_snapshots (
      organization_id,
      business_profile_id,
      status,
      generated_by_user_id,
      summary,
      data_health
    ) values (
      '10000000-0000-4000-8000-000000000042',
      '30000000-0000-4000-8000-000000000041',
      'generated',
      '00000000-0000-4000-8000-000000000041',
      '{}'::jsonb,
      '{}'::jsonb
    );
    raise exception 'expected cross-tenant dashboard insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_snapshots integer;
begin
  select count(*) into visible_snapshots from dashboard_snapshots;
  if visible_snapshots <> 0 then
    raise exception 'expected default-deny for dashboard snapshots, got %', visible_snapshots;
  end if;
end $$;

rollback;
