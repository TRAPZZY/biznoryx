begin;

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by_user_id uuid not null references app_users(id),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  actor_user_id uuid references app_users(id),
  event_type text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table organizations enable row level security;
alter table audit_events enable row level security;

create policy organizations_rls on organizations
  using (
    id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

create policy audit_events_rls on audit_events
  using (
    organization_id is null
    or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id is null
    or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

commit;
