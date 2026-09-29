begin;

create type membership_role as enum ('owner', 'admin', 'analyst', 'viewer');
create type membership_status as enum ('active', 'disabled');
create type invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  user_id uuid not null references app_users(id) on delete restrict,
  role membership_role not null,
  status membership_status not null default 'active',
  disabled_at timestamptz,
  invited_by_user_id uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  email text not null,
  role membership_role not null,
  token_hash text not null unique,
  status invitation_status not null default 'pending',
  invited_by_user_id uuid not null references app_users(id),
  accepted_by_user_id uuid references app_users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  session_token_hash text not null unique,
  csrf_token_hash text not null,
  active_organization_id uuid references organizations(id),
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index organization_memberships_user_idx on organization_memberships(user_id);
create index organization_memberships_org_status_idx on organization_memberships(organization_id, status);
create index organization_invitations_org_email_idx on organization_invitations(organization_id, lower(email));
create index user_sessions_user_idx on user_sessions(user_id);

alter table organization_memberships enable row level security;
alter table organization_invitations enable row level security;
alter table user_sessions enable row level security;

create policy organization_memberships_rls on organization_memberships
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy organization_invitations_rls on organization_invitations
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy user_sessions_self_rls on user_sessions
  using (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
  with check (
    user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );

commit;
