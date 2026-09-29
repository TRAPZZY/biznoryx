set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000001', 'alice@example.com', 'Alice', 'test-hash'),
  ('00000000-0000-4000-8000-000000000002', 'bob@example.com', 'Bob', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000001', 'Acme Retail', 'acme-retail', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'Beta Services', 'beta-services', '00000000-0000-4000-8000-000000000002');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'owner', 'active');

insert into audit_events (organization_id, actor_user_id, event_type, target_type, target_id)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'test.acme', 'organization', '10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'test.beta', 'organization', '10000000-0000-4000-8000-000000000002');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000001';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000001';

do $$
declare
  visible_organizations integer;
  visible_memberships integer;
  visible_audit_events integer;
begin
  select count(*) into visible_organizations from organizations;
  select count(*) into visible_memberships from organization_memberships;
  select count(*) into visible_audit_events from audit_events;

  if visible_organizations <> 1 then
    raise exception 'expected exactly one visible organization, got %', visible_organizations;
  end if;

  if visible_memberships <> 1 then
    raise exception 'expected exactly one visible membership, got %', visible_memberships;
  end if;

  if visible_audit_events <> 1 then
    raise exception 'expected exactly one visible audit event, got %', visible_audit_events;
  end if;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_organizations integer;
begin
  select count(*) into visible_organizations from organizations;
  if visible_organizations <> 0 then
    raise exception 'expected default-deny with no tenant context, got % organizations', visible_organizations;
  end if;
end $$;

set local app.current_user_id = '00000000-0000-4000-8000-000000000001';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000001';

insert into audit_events (organization_id, actor_user_id, event_type, target_type, target_id)
values (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'test.allowed_write',
  'organization',
  '10000000-0000-4000-8000-000000000001'
);

do $$
begin
  begin
    insert into audit_events (organization_id, actor_user_id, event_type, target_type, target_id)
    values (
      '10000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      'test.denied_write',
      'organization',
      '10000000-0000-4000-8000-000000000002'
    );
    raise exception 'expected cross-tenant audit insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

rollback;
