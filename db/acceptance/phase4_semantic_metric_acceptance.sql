set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000031', 'phase4-owner@example.com', 'Phase 4 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000032', 'phase4-other@example.com', 'Phase 4 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000031', 'Phase 4 Acme', 'phase4-acme', '00000000-0000-4000-8000-000000000031'),
  ('10000000-0000-4000-8000-000000000032', 'Phase 4 Beta', 'phase4-beta', '00000000-0000-4000-8000-000000000032');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000032', 'owner', 'active');

insert into business_profiles (
  id,
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
  '30000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000031',
  'Phase 4 Acme Ltd',
  'Retail',
  'Retail sales',
  'USD',
  1,
  'America/New_York',
  '00000000-0000-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000031'
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
  '39000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000031',
  '30000000-0000-4000-8000-000000000031',
  'Revenue',
  'Total net sales',
  'money',
  'sum mapped revenue field',
  'monthly sales stream',
  '00000000-0000-4000-8000-000000000031'
);

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', 'Phase 4 Sales Uploads', 'manual_upload', '00000000-0000-4000-8000-000000000031');

insert into data_streams (id, organization_id, data_source_id, name, display_name, grain, created_by_user_id)
values ('41000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000031', 'monthly_sales', 'Monthly sales', 'monthly', '00000000-0000-4000-8000-000000000031');

insert into stream_schema_versions (id, organization_id, data_stream_id, version, schema_fingerprint, columns, created_by_user_id)
values (
  '42000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000031',
  '41000000-0000-4000-8000-000000000031',
  1,
  'phase4-schema',
  '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb,
  '00000000-0000-4000-8000-000000000031'
);

insert into reporting_periods (id, organization_id, data_stream_id, period_start, period_end, label)
values ('43000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '41000000-0000-4000-8000-000000000031', '2027-01-01', '2027-01-31', 'January 2027');

insert into raw_data_objects (id, organization_id, storage_key, original_filename, content_type, byte_size, checksum_sha256, status, created_by_user_id)
values ('44000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', 'org/phase4/raw/sales.csv', 'sales.csv', 'text/csv', 128, 'phase4-checksum', 'accepted', '00000000-0000-4000-8000-000000000031');

set local app.current_organization_id = '10000000-0000-4000-8000-000000000031';

insert into ingestion_runs (
  id,
  organization_id,
  data_source_id,
  data_stream_id,
  reporting_period_id,
  raw_data_object_id,
  schema_version_id,
  status,
  schema_drift,
  row_count,
  column_count,
  created_by_user_id
) values (
  '45000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000031',
  '40000000-0000-4000-8000-000000000031',
  '41000000-0000-4000-8000-000000000031',
  '43000000-0000-4000-8000-000000000031',
  '44000000-0000-4000-8000-000000000031',
  '42000000-0000-4000-8000-000000000031',
  'validated',
  'none',
  2,
  2,
  '00000000-0000-4000-8000-000000000031'
);

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000031';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000031';

insert into semantic_mappings (id, organization_id, data_stream_id, schema_version_id, version, status, created_by_user_id, activated_at)
values ('50000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '41000000-0000-4000-8000-000000000031', '42000000-0000-4000-8000-000000000031', 1, 'active', '00000000-0000-4000-8000-000000000031', now());

insert into semantic_mapping_fields (organization_id, semantic_mapping_id, source_column, canonical_field, field_type)
values
  ('10000000-0000-4000-8000-000000000031', '50000000-0000-4000-8000-000000000031', 'date', 'transaction_date', 'date'),
  ('10000000-0000-4000-8000-000000000031', '50000000-0000-4000-8000-000000000031', 'revenue', 'revenue', 'measure');

insert into metric_calculation_specs (id, organization_id, kpi_definition_id, semantic_mapping_id, operation, measure_field, created_by_user_id)
values ('51000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '39000000-0000-4000-8000-000000000031', '50000000-0000-4000-8000-000000000031', 'sum', 'revenue', '00000000-0000-4000-8000-000000000031');

insert into verified_metric_runs (
  id,
  organization_id,
  kpi_definition_id,
  metric_calculation_spec_id,
  ingestion_run_id,
  reporting_period_id,
  status,
  value,
  unit,
  evidence,
  created_by_user_id
) values (
  '52000000-0000-4000-8000-000000000031',
  '10000000-0000-4000-8000-000000000031',
  '39000000-0000-4000-8000-000000000031',
  '51000000-0000-4000-8000-000000000031',
  '45000000-0000-4000-8000-000000000031',
  '43000000-0000-4000-8000-000000000031',
  'calculated',
  151,
  'sum',
  '{"rowCount":2,"operation":"sum","measureField":"revenue"}'::jsonb,
  '00000000-0000-4000-8000-000000000031'
);

insert into metric_run_validation_results (organization_id, verified_metric_run_id, severity, code, message)
values ('10000000-0000-4000-8000-000000000031', '52000000-0000-4000-8000-000000000031', 'info', 'METRIC_CALCULATED', 'Revenue calculated deterministically');

do $$
declare
  visible_mappings integer;
  visible_fields integer;
  visible_specs integer;
  visible_runs integer;
  visible_results integer;
begin
  select count(*) into visible_mappings from semantic_mappings;
  select count(*) into visible_fields from semantic_mapping_fields;
  select count(*) into visible_specs from metric_calculation_specs;
  select count(*) into visible_runs from verified_metric_runs;
  select count(*) into visible_results from metric_run_validation_results;

  if visible_mappings <> 1 or visible_fields <> 2 or visible_specs <> 1 or visible_runs <> 1 or visible_results <> 1 then
    raise exception 'unexpected semantic metric visibility mappings=% fields=% specs=% runs=% results=%',
      visible_mappings, visible_fields, visible_specs, visible_runs, visible_results;
  end if;
end $$;

do $$
begin
  begin
    insert into semantic_mappings (organization_id, data_stream_id, schema_version_id, version, created_by_user_id)
    values ('10000000-0000-4000-8000-000000000032', '41000000-0000-4000-8000-000000000031', '42000000-0000-4000-8000-000000000031', 1, '00000000-0000-4000-8000-000000000031');
    raise exception 'expected cross-tenant semantic mapping insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_runs integer;
begin
  select count(*) into visible_runs from verified_metric_runs;
  if visible_runs <> 0 then
    raise exception 'expected default-deny for verified metric runs, got %', visible_runs;
  end if;
end $$;

rollback;
