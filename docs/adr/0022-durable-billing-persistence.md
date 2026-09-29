# ADR 0022: Durable Billing Persistence

## Status

Accepted as a production foundation slice. Live PostgreSQL execution must be rerun when Docker or a production-like `DATABASE_URL` is available.

## Context

BIZNORYX has a customer-facing `$20/month` Paystack billing flow and signed webhook handling. Public production cannot rely on process memory for subscription state, checkout references, or webhook idempotency. Billing records must be tenant-owned, auditable, rollback-safe, and protected by PostgreSQL Row-Level Security.

## Decision

Add a durable billing persistence foundation:

- tenant-owned `organization_billing_subscriptions`;
- tenant-owned `billing_checkout_sessions`;
- tenant-owned `billing_webhook_events`;
- explicit billing provider/status/action enums;
- uniqueness for one subscription per organization, provider checkout references, and provider webhook event keys;
- RLS policies using `app.current_organization_id` with explicit `WITH CHECK`;
- restricted `biznoryx_app` runtime-role grants;
- rollback migration;
- SQL acceptance coverage for visibility, cross-tenant denial, and default-deny behavior;
- `PostgresBillingRepository` as the future HTTP-runtime persistence seam.

## Consequences

The billing subsystem now has the same database isolation posture as the rest of the BIZNORYX production kernel. The visible review app still uses guarded in-memory billing maps, so the next production step is to switch the HTTP billing routes to the repository once production database/runtime wiring is selected for the web app.
