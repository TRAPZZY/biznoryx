set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values (
  '00000000-0000-4000-8000-000000000027',
  'security-session-owner@example.invalid',
  'Security Session Owner',
  'test-hash'
);

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000027', 'Security Active', 'security-session-active', '00000000-0000-4000-8000-000000000027'),
  ('10000000-0000-4000-8000-000000000028', 'Security Disabled', 'security-session-disabled', '00000000-0000-4000-8000-000000000027');

insert into organization_memberships (organization_id, user_id, role, status)
values
  ('10000000-0000-4000-8000-000000000027', '00000000-0000-4000-8000-000000000027', 'owner', 'active'),
  ('10000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000027', 'viewer', 'active');

insert into user_sessions (
  id, user_id, session_token_hash, csrf_token_hash,
  active_organization_id, expires_at
)
values
  ('20000000-0000-4000-8000-000000000027', '00000000-0000-4000-8000-000000000027', repeat('a', 64), repeat('c', 64), '10000000-0000-4000-8000-000000000027', now() + interval '8 hours'),
  ('20000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000027', repeat('b', 64), repeat('c', 64), '10000000-0000-4000-8000-000000000028', now() + interval '8 hours'),
  ('20000000-0000-4000-8000-000000000029', '00000000-0000-4000-8000-000000000027', repeat('d', 64), repeat('c', 64), null, now() + interval '8 hours');

-- Disable the organization after its session exists, without disabling membership.
update organizations
set disabled_at = now()
where id = '10000000-0000-4000-8000-000000000028';

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000027';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000027';

do $$
declare
  context record;
begin
  select session_id, user_id, email, display_name, user_disabled_at,
         csrf_token_hash, active_organization_id, membership_role,
         membership_status, session_revoked_at, session_expires_at
  into strict context
  from runtime_session_context(repeat('b', 64));

  if context.membership_status is distinct from 'disabled'::membership_status then
    raise exception 'Disabled organization session must return disabled membership status';
  end if;

  if context.session_id is distinct from '20000000-0000-4000-8000-000000000028'::uuid
    or context.user_id is distinct from '00000000-0000-4000-8000-000000000027'::uuid
    or context.active_organization_id is distinct from '10000000-0000-4000-8000-000000000028'::uuid
    or context.membership_role is distinct from 'viewer'::membership_role then
    raise exception 'Disabled session context must preserve identity and organization for revocation';
  end if;

  select membership_status into strict context
  from runtime_session_context(repeat('a', 64));
  if context.membership_status is distinct from 'active'::membership_status then
    raise exception 'Active organization session must remain active';
  end if;

  select active_organization_id, membership_role, membership_status into strict context
  from runtime_session_context(repeat('d', 64));
  if context.active_organization_id is not null
    or context.membership_role is not null
    or context.membership_status is not null then
    raise exception 'Organization-free session context must remain organization-free';
  end if;

  if exists (select 1 from runtime_session_context(repeat('f', 64))) then
    raise exception 'Unknown session token must not return a context';
  end if;

  if exists (
    select 1
    from pg_proc function_definition
    cross join lateral aclexplode(coalesce(
      function_definition.proacl,
      acldefault('f', function_definition.proowner)
    )) privilege
    where function_definition.oid = 'runtime_session_context(text)'::regprocedure
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ) then
    raise exception 'Session context function must not be executable by public';
  end if;
end $$;

reset role;

update organizations
set disabled_at = null
where id = '10000000-0000-4000-8000-000000000028';

set local role biznoryx_app;

do $$
declare
  actual_status membership_status;
begin
  select membership_status into strict actual_status
  from runtime_session_context(repeat('b', 64));
  if actual_status is distinct from 'active'::membership_status then
    raise exception 'Re-enabled organization must return its actual membership status';
  end if;
end $$;

reset role;

update organization_memberships
set status = 'disabled', disabled_at = now()
where organization_id = '10000000-0000-4000-8000-000000000028'
  and user_id = '00000000-0000-4000-8000-000000000027';

set local role biznoryx_app;

do $$
declare
  actual_status membership_status;
begin
  select membership_status into strict actual_status
  from runtime_session_context(repeat('b', 64));
  if actual_status is distinct from 'disabled'::membership_status then
    raise exception 'Disabled membership must remain disabled in an active organization';
  end if;
end $$;

reset role;

-- Model a dangling organization reference. This constraint change is rolled back.
alter table user_sessions drop constraint user_sessions_active_organization_id_fkey;

insert into user_sessions (
  id, user_id, session_token_hash, csrf_token_hash,
  active_organization_id, expires_at
)
values (
  '20000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000027',
  repeat('e', 64), repeat('c', 64),
  '10000000-0000-4000-8000-000000000030',
  now() + interval '8 hours'
);

set local role biznoryx_app;

do $$
declare
  context record;
begin
  select active_organization_id, membership_status into strict context
  from runtime_session_context(repeat('e', 64));
  if context.active_organization_id is distinct from '10000000-0000-4000-8000-000000000030'::uuid
    or context.membership_status is distinct from 'disabled'::membership_status then
    raise exception 'Missing organization must fail closed and preserve the session organization';
  end if;
end $$;

rollback;
