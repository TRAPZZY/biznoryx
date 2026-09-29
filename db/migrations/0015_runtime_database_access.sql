begin;

create unique index app_users_email_lower_unique_idx on app_users (lower(email));

drop policy audit_events_rls on audit_events;

create policy audit_events_select_rls on audit_events
  for select
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy audit_events_insert_rls on audit_events
  for insert
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
    or (
      organization_id is null
      and actor_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    )
  );

create or replace function runtime_active_memberships(p_user_id uuid)
returns table (
  membership_id uuid,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  membership_role membership_role
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    membership.id,
    organization.id,
    organization.name,
    organization.slug,
    membership.role
  from organization_memberships membership
  join organizations organization on organization.id = membership.organization_id
  where membership.user_id = p_user_id
    and p_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    and membership.status = 'active'
    and organization.disabled_at is null
  order by membership.created_at, membership.id;
$$;

create or replace function runtime_session_context(p_session_token_hash text)
returns table (
  session_id uuid,
  user_id uuid,
  email text,
  display_name text,
  user_disabled_at timestamptz,
  csrf_token_hash text,
  active_organization_id uuid,
  membership_role membership_role,
  membership_status membership_status,
  session_revoked_at timestamptz,
  session_expires_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    session.id,
    app_user.id,
    app_user.email,
    app_user.display_name,
    app_user.disabled_at,
    session.csrf_token_hash,
    session.active_organization_id,
    membership.role,
    membership.status,
    session.revoked_at,
    session.expires_at
  from user_sessions session
  join app_users app_user on app_user.id = session.user_id
  left join organization_memberships membership
    on membership.organization_id = session.active_organization_id
   and membership.user_id = session.user_id
  where session.session_token_hash = p_session_token_hash;
$$;

revoke all on function runtime_active_memberships(uuid) from public;
revoke all on function runtime_session_context(text) from public;

commit;
