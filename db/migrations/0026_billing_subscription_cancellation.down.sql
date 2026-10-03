begin;

alter table organization_billing_subscriptions
  drop column if exists cancellation_requested_at,
  drop column if exists provider_email_token;

commit;
