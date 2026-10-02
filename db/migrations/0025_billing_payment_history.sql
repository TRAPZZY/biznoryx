begin;

create table billing_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  provider billing_provider not null,
  reference text not null check (length(reference) between 1 and 160),
  status text not null check (status = 'success'),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  channel text check (channel is null or length(channel) <= 80),
  paid_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider, reference)
);

create index billing_payments_organization_paid_idx
  on billing_payments(organization_id, paid_at desc, id desc);

alter table billing_payments enable row level security;

create policy billing_payments_rls on billing_payments
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

insert into billing_payments (
  organization_id,
  provider,
  reference,
  status,
  amount_minor,
  currency,
  paid_at
)
select
  organization_id,
  provider,
  reference,
  'success',
  amount_minor,
  currency,
  completed_at
from billing_checkout_sessions
where provider = 'paystack'
  and status = 'completed'
  and completed_at is not null
on conflict (provider, reference) do nothing;

commit;
