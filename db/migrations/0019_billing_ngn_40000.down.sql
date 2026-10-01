BEGIN;

-- Roll back the NGN 40,000 plan migration for any still-trial subscriptions.
-- This intentionally avoids re-pricing active customers and preserves the
-- current billing state for paid subscriptions.
UPDATE organization_billing_subscriptions
SET
  plan_id = 'biznoryx_monthly',
  plan_name = 'BIZNORYX Monthly',
  currency = 'NGN',
  amount_minor = 4000000,
  billing_interval = 'monthly',
  updated_at = now()
WHERE status = 'trialing';

COMMIT;
