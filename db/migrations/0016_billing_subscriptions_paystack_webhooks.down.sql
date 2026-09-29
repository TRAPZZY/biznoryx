begin;

drop policy if exists billing_webhook_events_rls on billing_webhook_events;
drop policy if exists billing_checkout_sessions_rls on billing_checkout_sessions;
drop policy if exists organization_billing_subscriptions_rls on organization_billing_subscriptions;
drop table if exists billing_webhook_events;
drop table if exists billing_checkout_sessions;
drop table if exists organization_billing_subscriptions;
drop type if exists billing_webhook_action;
drop type if exists billing_checkout_status;
drop type if exists billing_subscription_status;
drop type if exists billing_provider;

commit;
