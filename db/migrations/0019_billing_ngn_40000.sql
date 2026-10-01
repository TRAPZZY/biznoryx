BEGIN;

-- BIZNORYX has moved to a single NGN monthly plan.
--
-- Only subscriptions that have NOT yet become paid
-- subscriptions are migrated automatically.
--
-- Active subscriptions are deliberately left untouched
-- so an already-paid customer is never repriced silently.

UPDATE organization_billing_subscriptions
SET
  plan_id = 'biznoryx_monthly_ngn_40000',
  plan_name = 'BIZNORYX Monthly',
  currency = 'NGN',
  amount_minor = 4000000,
  billing_interval = 'monthly',
  updated_at = now()
WHERE status = 'trialing';

COMMIT;