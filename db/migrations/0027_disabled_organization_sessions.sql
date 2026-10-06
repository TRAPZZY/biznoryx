begin;

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
    case
      when session.active_organization_id is not null
        and (organization.id is null or organization.disabled_at is not null)
      then 'disabled'::membership_status
      else membership.status
    end,
    session.revoked_at,
    session.expires_at
  from user_sessions session
  join app_users app_user on app_user.id = session.user_id
  left join organizations organization
    on organization.id = session.active_organization_id
  left join organization_memberships membership
    on membership.organization_id = session.active_organization_id
   and membership.user_id = session.user_id
  where session.session_token_hash = p_session_token_hash;
$$;

commit;
