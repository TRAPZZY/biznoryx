set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000091', 'phase9-owner@example.com', 'Phase 9 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000092', 'phase9-other@example.com', 'Phase 9 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000091', 'Phase 9 Acme', 'phase9-acme', '00000000-0000-4000-8000-000000000091'),
  ('10000000-0000-4000-8000-000000000092', 'Phase 9 Beta', 'phase9-beta', '00000000-0000-4000-8000-000000000092');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000091', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000092', '10000000-0000-4000-8000-000000000092', '00000000-0000-4000-8000-000000000092', 'owner', 'active');

insert into business_profiles (id, organization_id, legal_name, industry, business_model, primary_currency, fiscal_year_start_month, timezone, status, created_by_user_id, updated_by_user_id)
values ('30000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', 'Phase 9 Acme Ltd', 'Retail', 'Retail sales', 'USD', 1, 'America/New_York', 'completed', '00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000091');

insert into kpi_definitions (id, organization_id, business_profile_id, name, description, value_type, calculation_method, source_hint, created_by_user_id)
values ('39000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000091', 'Revenue', 'Total net sales', 'money', 'sum mapped revenue field', 'monthly sales stream', '00000000-0000-4000-8000-000000000091');

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', 'Phase 9 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000091');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '40000000-0000-4000-8000-000000000091', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000091');

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values ('43000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '41000000-0000-4000-8000-000000000091', '2027-02-01', '2027-02-28', 'February 2027');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values ('42000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '41000000-0000-4000-8000-000000000091', 1, 'phase9-schema', '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb, '00000000-0000-4000-8000-000000000091');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values ('44000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', 'org/phase9/raw/february.csv', 'february.csv', 'text/csv', 128, 'phase9-checksum-feb', 'accepted', '00000000-0000-4000-8000-000000000091');

set local app.current_organization_id = '10000000-0000-4000-8000-000000000091';

insert into ingestion_runs (id, organization_id, data_source_id, data_stream_id, reporting_period_id, raw_data_object_id, schema_version_id, status, schema_drift, row_count, column_count, created_by_user_id)
values ('45000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '40000000-0000-4000-8000-000000000091', '41000000-0000-4000-8000-000000000091', '43000000-0000-4000-8000-000000000091', '44000000-0000-4000-8000-000000000091', '42000000-0000-4000-8000-000000000091', 'validated', 'none', 2, 2, '00000000-0000-4000-8000-000000000091');

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id)
values ('50000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '41000000-0000-4000-8000-000000000091', '42000000-0000-4000-8000-000000000091', 1, 'active', '00000000-0000-4000-8000-000000000091');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '39000000-0000-4000-8000-000000000091', '50000000-0000-4000-8000-000000000091', 'sum', 'revenue', '00000000-0000-4000-8000-000000000091');

insert into verified_metric_runs (id, organization_id, kpi_definition_id, metric_calculation_spec_id, ingestion_run_id, reporting_period_id, status, value, unit, evidence, created_by_user_id)
values ('52000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091', '39000000-0000-4000-8000-000000000091', '51000000-0000-4000-8000-000000000091', '45000000-0000-4000-8000-000000000091', '43000000-0000-4000-8000-000000000091', 'calculated', 125, 'sum', '{"rowCount":2}'::jsonb, '00000000-0000-4000-8000-000000000091');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000091';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000091';

insert into professional_reports (
  id,
  organization_id,
  business_profile_id,
  reporting_period_id,
  title,
  status,
  summary,
  generated_by_user_id
) values (
  'a0000000-0000-4000-8000-000000000091',
  '10000000-0000-4000-8000-000000000091',
  '30000000-0000-4000-8000-000000000091',
  '43000000-0000-4000-8000-000000000091',
  'February Performance Review',
  'generated',
  'Generated from verified metric evidence.',
  '00000000-0000-4000-8000-000000000091'
);

insert into professional_report_sections (
  id,
  organization_id,
  professional_report_id,
  section_order,
  kind,
  heading,
  body,
  evidence
) values (
  'a1000000-0000-4000-8000-000000000091',
  '10000000-0000-4000-8000-000000000091',
  'a0000000-0000-4000-8000-000000000091',
  1,
  'kpi_scorecard',
  'KPI Scorecard',
  'Revenue: 125 money',
  '{"verifiedMetricRunIds":["52000000-0000-4000-8000-000000000091"]}'::jsonb
);

do $$
declare
  visible_reports integer;
  visible_sections integer;
begin
  select count(*) into visible_reports from professional_reports;
  select count(*) into visible_sections from professional_report_sections;
  if visible_reports <> 1 or visible_sections <> 1 then
    raise exception 'unexpected report visibility reports=% sections=%', visible_reports, visible_sections;
  end if;
end $$;

do $$
begin
  begin
    insert into professional_reports (
      organization_id,
      business_profile_id,
      title,
      summary,
      generated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000092',
      '30000000-0000-4000-8000-000000000091',
      'Cross tenant report',
      'This insert must be rejected by RLS.',
      '00000000-0000-4000-8000-000000000091'
    );
    raise exception 'expected cross-tenant report insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_reports integer;
begin
  select count(*) into visible_reports from professional_reports;
  if visible_reports <> 0 then
    raise exception 'expected default-deny for professional reports, got %', visible_reports;
  end if;
end $$;

rollback;
