# Four-tier billing release notes

The current web runtime uses one Paystack plan configured by PAYSTACK_PLAN_CODE. Checkout, verification, cancellation, renewal and payment history use the existing organization billing repository. A separate trial service controls card verification and scheduled charges. The existing premium check determines whether an organization has access through its billing period. It does not distinguish commercial tiers.

Paystack Live showed zero subscriptions on BIZNORYX Monthly. That screen cannot establish the absence of scheduled debits in PostgreSQL or unresolved Paystack transactions. Before release, reconcile outstanding checkout references and due or in-flight trial charges with the provider using read-only access. Confirm the live application is configured for the merchant inspected.

This branch introduces a versioned, read-only monthly price catalog. It requires no migration. All catalog entries have purchases disabled. The existing checkout and marketing page continue to use the current commercial configuration until the new purchase flow is ready.

Remaining implementation:

1. Carry the selected price identity through checkout intent, verification, webhook reconciliation and trial consent. Keep each existing agreement's amount and provider reference. Validate each new Paystack plan's code, currency, interval, amount and mode with the server credential before initialization.
2. Resolve the effective plan from verified organization billing. Add server-side feature checks and transactionally reserve quotas before expensive operations. Keep role checks and tenant isolation independent of the plan. Benchmark capacity before publishing limits.
3. Connect pricing and authenticated billing views to the catalog. Keep web checkout outside the Play-distributed app. Start with support-assisted plan changes until the provider lifecycle can be reconciled safely.
4. Test with a disposable PostgreSQL database and Paystack sandbox. Verify existing trial, cancellation, renewal and payment-history behavior before enabling sales. Release only after schema, recovery and provider checks pass. If checkout has been enabled, stop new checkout before rolling back the runtime and reconcile pending payments and provider subscriptions separately.

Import docs/postman/pricing-catalog.postman_collection.json into Postman and set the collection's baseUrl to the local or staging server running this branch. The request is read-only and needs no authentication. The production route will be available only after a future release.

The trial checkout supports selection by versioned price ID when BIZNORYX_TIER_PRICING_ENABLED is true. Set PAYSTACK_PLAN_CODE_STARTER, PAYSTACK_PLAN_CODE_GROWTH, PAYSTACK_PLAN_CODE_BUSINESS and PAYSTACK_PLAN_CODE_BUSINESS_PLUS to four separate plans in the environment used by the Paystack key. Trial checkout verifies the selected provider plan before card verification and publishes the consented price to the existing subscription row. Keep the flag off in production until direct checkout, tier restrictions and sandbox verification are complete.
