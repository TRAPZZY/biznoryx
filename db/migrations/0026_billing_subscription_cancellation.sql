begin;

alter table organization_billing_subscriptions
  add column provider_email_token text,
  add column cancellation_requested_at timestamptz;

commit;
