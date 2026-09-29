set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000021', 'phase3-owner@example.com', 'Phase 3 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000022', 'phase3-other@example.com', 'Phase 3 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000021', 'Phase 3 Acme', 'phase3-acme', '00000000-0000-4000-8000-000000000021'),
  ('10000000-0000-4000-8000-000000000022', 'Phase 3 Beta', 'phase3-beta', '00000000-0000-4000-8000-000000000022');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000021', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000022', 'owner', 'active');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000021';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000021';

insert into data_sources (
  id,
  organization_id,
  name,
  source_type,
  description,
  created_by_user_id
) values (
  '40000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  'Monthly Sales Uploads',
  'manual_upload',
  'Owner-uploaded recurring sales files',
  '00000000-0000-4000-8000-000000000021'
);

insert into data_streams (
  id,
  organization_id,
  data_source_id,
  name,
  display_name,
  grain,
  created_by_user_id
) values (
  '41000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  '40000000-0000-4000-8000-000000000021',
  'monthly_sales',
  'Monthly sales',
  'monthly',
  '00000000-0000-4000-8000-000000000021'
);

insert into stream_schema_versions (
  id,
  organization_id,
  data_stream_id,
  version,
  schema_fingerprint,
  columns,
  created_by_user_id
) values (
  '42000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  '41000000-0000-4000-8000-000000000021',
  1,
  'phase3-schema-fingerprint',
  '[{"name":"date","type":"date","required":true},{"name":"revenue","type":"money","required":true}]'::jsonb,
  '00000000-0000-4000-8000-000000000021'
);

update data_streams
set expected_schema_fingerprint = 'phase3-schema-fingerprint',
    active_schema_version_id = '42000000-0000-4000-8000-000000000021'
where id = '41000000-0000-4000-8000-000000000021';

insert into reporting_periods (
  id,
  organization_id,
  data_stream_id,
  period_start,
  period_end,
  label
) values (
  '43000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  '41000000-0000-4000-8000-000000000021',
  '2027-01-01',
  '2027-01-31',
  'January 2027'
);

insert into raw_data_objects (
  id,
  organization_id,
  storage_key,
  original_filename,
  content_type,
  byte_size,
  checksum_sha256,
  status,
  created_by_user_id
) values (
  '44000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  'org/phase3/raw/january-sales.csv',
  'january-sales.csv',
  'text/csv',
  128,
  'phase3-checksum',
  'accepted',
  '00000000-0000-4000-8000-000000000021'
);

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
  '45000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000021',
  '40000000-0000-4000-8000-000000000021',
  '41000000-0000-4000-8000-000000000021',
  '43000000-0000-4000-8000-000000000021',
  '44000000-0000-4000-8000-000000000021',
  '42000000-0000-4000-8000-000000000021',
  'validated',
  'none',
  12,
  2,
  '00000000-0000-4000-8000-000000000021'
);

insert into ingestion_validation_results (
  organization_id,
  ingestion_run_id,
  severity,
  code,
  message
) values (
  '10000000-0000-4000-8000-000000000021',
  '45000000-0000-4000-8000-000000000021',
  'info',
  'BASELINE_SCHEMA_ESTABLISHED',
  'Initial recurring stream schema accepted'
);

do $$
declare
  visible_sources integer;
  visible_streams integer;
  visible_schema_versions integer;
  visible_periods integer;
  visible_raw_objects integer;
  visible_runs integer;
  visible_results integer;
begin
  select count(*) into visible_sources from data_sources;
  select count(*) into visible_streams from data_streams;
  select count(*) into visible_schema_versions from stream_schema_versions;
  select count(*) into visible_periods from reporting_periods;
  select count(*) into visible_raw_objects from raw_data_objects;
  select count(*) into visible_runs from ingestion_runs;
  select count(*) into visible_results from ingestion_validation_results;

  if visible_sources <> 1 or visible_streams <> 1 or visible_schema_versions <> 1 or visible_periods <> 1 or visible_raw_objects <> 1 or visible_runs <> 1 or visible_results <> 1 then
    raise exception 'unexpected ingestion visibility sources=% streams=% schema_versions=% periods=% raw_objects=% runs=% results=%',
      visible_sources, visible_streams, visible_schema_versions, visible_periods, visible_raw_objects, visible_runs, visible_results;
  end if;
end $$;

do $$
begin
  begin
    insert into data_sources (
      organization_id,
      name,
      source_type,
      created_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000022',
      'Cross Tenant Source',
      'manual_upload',
      '00000000-0000-4000-8000-000000000021'
    );
    raise exception 'expected cross-tenant data source insert to fail';
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
  select count(*) into visible_runs from ingestion_runs;
  if visible_runs <> 0 then
    raise exception 'expected default-deny for ingestion runs, got %', visible_runs;
  end if;
end $$;

rollback;
