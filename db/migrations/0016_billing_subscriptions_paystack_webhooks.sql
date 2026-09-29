begin;

create type billing_provider as enum ('paystack', 'local_review');
create type billing_subscription_status as enum ('trialing', 'pending_checkout', 'active', 'past_due', 'non_renewing', 'canceled');
create type billing_checkout_status as enum ('pending', 'completed', 'expired', 'failed');
create type billing_webhook_action as enum (
  'subscription_activated',
  'subscription_renewed',
  'subscription_past_due',
  'subscription_canceled',
  'subscription_non_renewing',
  'ignored'
);

create table organization_billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  provider billing_provider not null,
  provider_customer_code text,
  provider_subscription_code text,
  plan_id text not null,
  plan_name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor integer not null check (amount_minor > 0),
  billing_interval text not null check (billing_interval in ('monthly')),
  status billing_subscription_status not null,
  checkout_reference text,
  trial_ends_at timestamptz,
  active_at timestamptz,
  current_period_end timestamptz,
  created_by_user_id uuid references app_users(id),
  updated_by_user_id uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table billing_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  actor_user_id uuid references app_users(id),
  provider billing_provider not null,
  reference text not null,
  status billing_checkout_status not null default 'pending',
  authorization_url text,
  access_code text,
  plan_id text not null,
  plan_name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor integer not null check (amount_minor > 0),
  billing_interval text not null check (billing_interval in ('monthly')),
  metadata jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, reference)
);

create table billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  provider billing_provider not null,
  event_key text not null,
  event_name text not null,
  reference text,
  payload_sha256 text not null check (length(payload_sha256) = 64),
  action billing_webhook_action not null,
  processed_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (provider, event_key)
);

create index organization_billing_subscriptions_org_status_idx
  on organization_billing_subscriptions(organization_id, status);
create index billing_checkout_sessions_org_status_idx
  on billing_checkout_sessions(organization_id, status, created_at desc);
create index billing_webhook_events_org_received_idx
  on billing_webhook_events(organization_id, received_at desc);
create index billing_webhook_events_reference_idx
  on billing_webhook_events(provider, reference);

alter table organization_billing_subscriptions enable row level security;
alter table billing_checkout_sessions enable row level security;
alter table billing_webhook_events enable row level security;

create policy organization_billing_subscriptions_rls on organization_billing_subscriptions
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy billing_checkout_sessions_rls on billing_checkout_sessions
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy billing_webhook_events_rls on billing_webhook_events
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
