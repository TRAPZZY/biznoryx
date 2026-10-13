begin;
alter table organization_billing_subscriptions
  alter column amount_minor drop not null,
  alter column currency drop not null;
alter table organization_billing_subscriptions add constraint billing_provider_pricing_check check (
  (provider in ('app_store','play_store') and amount_minor is null and currency is null) or
  (provider not in ('app_store','play_store') and amount_minor is not null and currency is not null)
);
create table organization_store_accounts (
  organization_id uuid primary key references organizations(id) on delete restrict,
  customer_id uuid not null default gen_random_uuid() unique,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create table store_billing_transactions (
  transaction_hash text primary key check (length(transaction_hash) = 64),
  organization_id uuid not null references organizations(id) on delete restrict,
  store text not null check (store in ('app_store','play_store')),
  product_id text not null,
  verified_at timestamptz not null default now()
);
create table retired_store_transactions (
  transaction_hash text primary key check (length(transaction_hash) = 64),
  retired_at timestamptz not null default now()
);
create function runtime_store_transaction_retired(p_hash text)
returns boolean language sql security definer set search_path = public, pg_temp stable as $$
  select exists(select 1 from retired_store_transactions where transaction_hash = p_hash);
$$;
revoke all on function runtime_store_transaction_retired(text) from public;
alter table organization_store_accounts enable row level security;
alter table store_billing_transactions enable row level security;
create policy store_accounts_tenant on organization_store_accounts
  using (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
create policy store_transactions_tenant on store_billing_transactions
  using (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
create function runtime_store_customer_organization(p_customer uuid)
returns uuid language sql security definer set search_path = public, pg_temp stable as $$
  select a.organization_id from organization_store_accounts a join organizations o on o.id = a.organization_id
    where a.customer_id = p_customer and o.disabled_at is null;
$$;
revoke all on function runtime_store_customer_organization(uuid) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant select,insert,update on organization_store_accounts,store_billing_transactions to biznoryx_app;
    grant execute on function runtime_store_customer_organization(uuid) to biznoryx_app;
    grant execute on function runtime_store_transaction_retired(text) to biznoryx_app;
  end if;
end $$;
commit;
