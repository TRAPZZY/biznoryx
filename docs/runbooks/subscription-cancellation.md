# Subscription cancellation

Website owners cancel in Billing. The server authenticates the session, checks CSRF and workspace ownership, and stops renewal at Paystack before recording `non_renewing`. Existing paid-through access, account records and prices are preserved. Native store billing restrictions remain unchanged.

The saved Paystack subscription code can recover a missing email token without a checkout reference or current commercial plan. Recovery never selects another workspace's subscription by customer email or shared plan. If Paystack already confirms the exact bound subscription is non-renewing or canceled, a retry reconciles local state without another disable request. An ambiguous or conflicting identity fails closed and requires support reconciliation.

Paystack disable requests, including response bodies, have a 15-second deadline. An uncertain disable response is checked against the same subscription. If neither success nor confirmed provider cancellation is available, the server returns an error rather than a false confirmation.

After local cancellation commits, the existing `RESEND_API_KEY` and `BIZNORYX_EMAIL_FROM` configuration sends a text/HTML confirmation to the authenticated account email. `accepted` means Resend accepted the message, not that inbox delivery is proven. Email failure does not undo cancellation. The non-renewing Billing view exposes **Email cancellation confirmation** for an explicit retry. Resend's idempotency key is stable for the subscription, cancellation timestamp and recipient; it deduplicates retries within the provider's retention window. This is not a durable email queue or a guarantee against duplicates after that window.

No new secrets or database migrations are required. A missing `billing_payments` table is a separate payment-history installation issue; cancellation does not query that table. Do not fabricate a successful payment history or apply unrelated schema repairs as part of this fix.

## Verification

`node --test tests/billing-cancellation.test.mjs tests/billing-security.test.mjs tests/billing-renewal.test.mjs tests/billing-renewal-replacement.test.mjs tests/production-app.test.mjs`

`npx playwright test tests/browser/billing-cancellation.spec.mjs`

`npm run verify`

Use only an owner-designated test subscription for a live provider cancellation. Do not cancel real customer subscriptions to test deployment. Confirm the visible non-renewing state, unchanged paid-through date and actual email receipt separately. A successful health check does not prove a live payment-provider cancellation or inbox delivery.

## Deployment and rollback

Merge after CI passes and retain the previous healthy Northflank build. Existing continuous deployment follows `main`; do not trigger a duplicate deployment. Confirm the deployed commit, `/healthz`, `/readyz` and relevant service logs. Roll back to the previous healthy build if the patch causes a critical regression. No schema rollback is needed. Rolling back application code cannot reactivate subscriptions already canceled at Paystack; never re-enable billing without the customer's instruction.
