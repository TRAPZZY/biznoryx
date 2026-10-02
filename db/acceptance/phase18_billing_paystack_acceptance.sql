set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000181', 'phase18-owner@example.com', 'Phase 18 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000182', 'phase18-other@example.com', 'Phase 18 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000181', 'Phase 18 Acme', 'phase18-acme', '00000000-0000-4000-8000-000000000181'),
  ('10000000-0000-4000-8000-000000000182', 'Phase 18 Beta', 'phase18-beta', '00000000-0000-4000-8000-000000000182');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000181', '10000000-0000-4000-8000-000000000181', '00000000-0000-4000-8000-000000000181', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000182', '10000000-0000-4000-8000-000000000182', '00000000-0000-4000-8000-000000000182', 'owner', 'active');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000181';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000181';

insert into organization_billing_subscriptions (
  id,
  organization_id,
  provider,
  provider_customer_code,
  provider_subscription_code,
  plan_id,
  plan_name,
  currency,
  amount_minor,
  billing_interval,
  status,
  checkout_reference,
  created_by_user_id,
  updated_by_user_id
) values (
  '30000000-0000-4000-8000-000000000181',
  '10000000-0000-4000-8000-000000000181',
  'paystack',
  'CUS_phase18',
  'SUB_phase18',
  'biznoryx_monthly',
  'BIZNORYX Monthly',
  'USD',
  2000,
  'monthly',
  'active',
  'phase18-ref',
  '00000000-0000-4000-8000-000000000181',
  '00000000-0000-4000-8000-000000000181'
);

insert into billing_checkout_sessions (
  id,
  organization_id,
  actor_user_id,
  provider,
  reference,
  status,
  authorization_url,
  access_code,
  plan_id,
  plan_name,
  currency,
  amount_minor,
  billing_interval
) values (
  '40000000-0000-4000-8000-000000000181',
  '10000000-0000-4000-8000-000000000181',
  '00000000-0000-4000-8000-000000000181',
  'paystack',
  'phase18-ref',
  'completed',
  'https://checkout.paystack.com/phase18',
  'access_phase18',
  'biznoryx_monthly',
  'BIZNORYX Monthly',
  'USD',
  2000,
  'monthly'
);

insert into billing_webhook_events (
  id,
  organization_id,
  provider,
  event_key,
  event_name,
  reference,
  payload_sha256,
  action
) values (
  '50000000-0000-4000-8000-000000000181',
  '10000000-0000-4000-8000-000000000181',
  'paystack',
  'charge.success:phase18-ref',
  'charge.success',
  'phase18-ref',
  repeat('a', 64),
  'subscription_activated'
);

insert into billing_payments (
  id,
  organization_id,
  provider,
  reference,
  status,
  amount_minor,
  currency,
  channel,
  paid_at
) values (
  '60000000-0000-4000-8000-000000000181',
  '10000000-0000-4000-8000-000000000181',
  'paystack',
  'phase18-ref',
  'success',
  2000,
  'USD',
  'card',
  now()
);

do $$
declare
  visible_subscriptions integer;
  visible_checkouts integer;
  visible_webhooks integer;
  visible_payments integer;
begin
  select count(*) into visible_subscriptions from organization_billing_subscriptions;
  select count(*) into visible_checkouts from billing_checkout_sessions;
  select count(*) into visible_webhooks from billing_webhook_events;
  select count(*) into visible_payments from billing_payments;
  if visible_subscriptions <> 1 or visible_checkouts <> 1 or visible_webhooks <> 1 or visible_payments <> 1 then
    raise exception 'unexpected billing visibility subscriptions=% checkouts=% webhooks=% payments=%', visible_subscriptions, visible_checkouts, visible_webhooks, visible_payments;
  end if;
end $$;

do $$
begin
  begin
    insert into billing_checkout_sessions (
      organization_id,
      actor_user_id,
      provider,
      reference,
      plan_id,
      plan_name,
      currency,
      amount_minor,
      billing_interval
    ) values (
      '10000000-0000-4000-8000-000000000182',
      '00000000-0000-4000-8000-000000000181',
      'paystack',
      'cross-tenant-ref',
      'biznoryx_monthly',
      'BIZNORYX Monthly',
      'USD',
      2000,
      'monthly'
    );
    raise exception 'expected cross-tenant billing checkout insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

do $$
begin
  begin
    insert into billing_payments (
      organization_id,
      provider,
      reference,
      status,
      amount_minor,
      currency,
      paid_at
    ) values (
      '10000000-0000-4000-8000-000000000182',
      'paystack',
      'cross-tenant-payment-ref',
      'success',
      2000,
      'USD',
      now()
    );
    raise exception 'expected cross-tenant billing payment insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_webhooks integer;
  visible_payments integer;
begin
  select count(*) into visible_webhooks from billing_webhook_events;
  select count(*) into visible_payments from billing_payments;
  if visible_webhooks <> 0 or visible_payments <> 0 then
    raise exception 'expected default-deny for billing history, got webhooks=% payments=%', visible_webhooks, visible_payments;
  end if;
end $$;

rollback;
