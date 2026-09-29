set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000101', 'phase10-owner@example.com', 'Phase 10 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000102', 'phase10-other@example.com', 'Phase 10 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000101', 'Phase 10 Acme', 'phase10-acme', '00000000-0000-4000-8000-000000000101'),
  ('10000000-0000-4000-8000-000000000102', 'Phase 10 Beta', 'phase10-beta', '00000000-0000-4000-8000-000000000102');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000101', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000102', 'owner', 'active');

insert into data_sources (id, organization_id, name, source_type, created_by_user_id)
values ('40000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101', 'Phase 10 Accounting API', 'api', '00000000-0000-4000-8000-000000000101');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000101';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000101';

insert into integration_connections (
  id,
  organization_id,
  data_source_id,
  provider_key,
  provider_kind,
  display_name,
  status,
  scopes,
  secret_ref,
  config,
  created_by_user_id,
  updated_by_user_id
) values (
  'b0000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000101',
  'custom_accounting',
  'accounting',
  'Accounting API',
  'active',
  array['transactions:read'],
  'vault://org/phase10/accounting',
  '{"mode":"read_only"}'::jsonb,
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000101'
);

insert into integration_sync_runs (
  id,
  organization_id,
  integration_connection_id,
  idempotency_key,
  status,
  started_at,
  finished_at,
  records_seen,
  records_accepted,
  records_rejected,
  evidence,
  created_by_user_id
) values (
  'b1000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  'b0000000-0000-4000-8000-000000000101',
  'sync-2027-02',
  'succeeded',
  now(),
  now(),
  10,
  9,
  1,
  '{"window":"2027-02"}'::jsonb,
  '00000000-0000-4000-8000-000000000101'
);

update integration_connections
set last_sync_run_id = 'b1000000-0000-4000-8000-000000000101',
    last_successful_sync_at = now()
where id = 'b0000000-0000-4000-8000-000000000101';

insert into integration_webhook_events (
  id,
  organization_id,
  integration_connection_id,
  provider_event_id,
  idempotency_key,
  status,
  payload_fingerprint,
  evidence,
  created_by_user_id
) values (
  'b2000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000101',
  'b0000000-0000-4000-8000-000000000101',
  'evt_1',
  'delivery_1',
  'processed',
  repeat('a', 64),
  '{"providerKey":"custom_accounting"}'::jsonb,
  '00000000-0000-4000-8000-000000000101'
);

do $$
declare
  visible_connections integer;
  visible_runs integer;
  visible_events integer;
begin
  select count(*) into visible_connections from integration_connections;
  select count(*) into visible_runs from integration_sync_runs;
  select count(*) into visible_events from integration_webhook_events;
  if visible_connections <> 1 or visible_runs <> 1 or visible_events <> 1 then
    raise exception 'unexpected integration visibility connections=% runs=% events=%', visible_connections, visible_runs, visible_events;
  end if;
end $$;

do $$
begin
  begin
    insert into integration_connections (
      organization_id,
      provider_key,
      provider_kind,
      display_name,
      status,
      created_by_user_id,
      updated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000102',
      'cross_tenant',
      'custom_api',
      'Cross Tenant',
      'draft',
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000101'
    );
    raise exception 'expected cross-tenant integration insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_connections integer;
begin
  select count(*) into visible_connections from integration_connections;
  if visible_connections <> 0 then
    raise exception 'expected default-deny for integration connections, got %', visible_connections;
  end if;
end $$;

rollback;
