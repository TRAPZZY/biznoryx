set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000111', 'phase11-owner@example.com', 'Phase 11 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000112', 'phase11-other@example.com', 'Phase 11 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000111', 'Phase 11 Acme', 'phase11-acme', '00000000-0000-4000-8000-000000000111'),
  ('10000000-0000-4000-8000-000000000112', 'Phase 11 Beta', 'phase11-beta', '00000000-0000-4000-8000-000000000112');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000111', '10000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000111', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000112', '10000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000112', 'owner', 'active');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000111';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000111';

insert into alert_rules (
  id,
  organization_id,
  name,
  condition_kind,
  severity,
  status,
  config,
  created_by_user_id,
  updated_by_user_id
) values (
  'c0000000-0000-4000-8000-000000000111',
  '10000000-0000-4000-8000-000000000111',
  'Sync failures',
  'sync_failure',
  'high',
  'active',
  '{}'::jsonb,
  '00000000-0000-4000-8000-000000000111',
  '00000000-0000-4000-8000-000000000111'
);

insert into alert_events (
  id,
  organization_id,
  alert_rule_id,
  status,
  severity,
  title,
  message,
  source_type,
  source_id,
  fingerprint,
  evidence
) values (
  'c1000000-0000-4000-8000-000000000111',
  '10000000-0000-4000-8000-000000000111',
  'c0000000-0000-4000-8000-000000000111',
  'open',
  'high',
  'Integration sync failed',
  'Provider payload changed.',
  'integration_sync_run',
  null,
  'sync_failure:test',
  '{"errorCode":"SCHEMA_MISMATCH"}'::jsonb
);

insert into alert_notifications (
  id,
  organization_id,
  alert_event_id,
  channel,
  recipient,
  status
) values (
  'c2000000-0000-4000-8000-000000000111',
  '10000000-0000-4000-8000-000000000111',
  'c1000000-0000-4000-8000-000000000111',
  'email',
  'ops@example.com',
  'pending'
);

do $$
declare
  visible_rules integer;
  visible_events integer;
  visible_notifications integer;
begin
  select count(*) into visible_rules from alert_rules;
  select count(*) into visible_events from alert_events;
  select count(*) into visible_notifications from alert_notifications;
  if visible_rules <> 1 or visible_events <> 1 or visible_notifications <> 1 then
    raise exception 'unexpected alert visibility rules=% events=% notifications=%', visible_rules, visible_events, visible_notifications;
  end if;
end $$;

do $$
begin
  begin
    insert into alert_rules (
      organization_id,
      name,
      condition_kind,
      severity,
      created_by_user_id,
      updated_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000112',
      'Cross tenant alert',
      'sync_failure',
      'high',
      '00000000-0000-4000-8000-000000000111',
      '00000000-0000-4000-8000-000000000111'
    );
    raise exception 'expected cross-tenant alert rule insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_rules integer;
begin
  select count(*) into visible_rules from alert_rules;
  if visible_rules <> 0 then
    raise exception 'expected default-deny for alert rules, got %', visible_rules;
  end if;
end $$;

rollback;
