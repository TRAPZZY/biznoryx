begin;

-- Legacy trialing subscriptions are deliberately not backfilled.
create table billing_trials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete restrict,
  reference text not null unique check (reference like 'bnx_trial_%' and length(reference) <= 160),
  provider_subscription_code text unique,
  card_verified_at timestamptz,
  started_at timestamptz,
  ends_at timestamptz,
  canceled_at timestamptz,
  converted_at timestamptz,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((started_at is null and ends_at is null) or
    (card_verified_at is not null and provider_subscription_code is not null and
     started_at is not null and ends_at = started_at + interval '168 hours')),
  check (canceled_at is null or converted_at is null)
);

create table billing_trial_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  trial_id uuid not null references billing_trials(id) on delete restrict,
  actor_user_id uuid references app_users(id),
  version integer not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (trial_id, version)
);

create index billing_trials_pending_idx on billing_trials(updated_at, organization_id)
  where converted_at is null;
create index billing_trial_audit_org_idx on billing_trial_audit(organization_id, created_at);

alter table billing_trials enable row level security;
alter table billing_trial_audit enable row level security;
create policy billing_trials_tenant on billing_trials
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy billing_trial_audit_tenant on billing_trial_audit
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

-- These narrow resolvers disclose only a tenant ID, never tokens or card details.
create function runtime_paystack_trial_organization(p_reference text, p_subscription_code text)
returns uuid language sql security definer set search_path = public, pg_temp stable as $$
  select organization_id from public.billing_trials
  where (p_reference is not null and reference = p_reference)
     or (p_subscription_code is not null and provider_subscription_code = p_subscription_code)
  order by organization_id limit 1;
$$;
create function runtime_pending_trial_organizations(p_limit integer)
returns table (organization_id uuid) language sql security definer
set search_path = public, pg_temp stable as $$
  select organization_id from public.billing_trials
  where ((converted_at is null and (ends_at is null or ends_at > now() - interval '30 days'))
      or state->>'refundStatus' not in ('processed', 'not_required')
      or state->>'cancelStatus' = 'requested' or state->>'provisionStatus' = 'attempted')
    and coalesce((state->>'nextProcessAt')::timestamptz, '-infinity'::timestamptz) <= now()
  order by updated_at limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function runtime_paystack_trial_organization(text, text) from public;
revoke all on function runtime_pending_trial_organizations(integer) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant select, insert, update on billing_trials to biznoryx_app;
    grant select, insert on billing_trial_audit to biznoryx_app;
    grant execute on function runtime_paystack_trial_organization(text, text) to biznoryx_app;
    grant execute on function runtime_pending_trial_organizations(integer) to biznoryx_app;
  end if;
end $$;

commit;
