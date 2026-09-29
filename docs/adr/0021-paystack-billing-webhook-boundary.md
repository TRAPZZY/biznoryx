# ADR 0021: Paystack Billing Webhook Boundary

## Status

Accepted for local review. Public production still requires real Paystack live keys, a configured Paystack plan, a public HTTPS webhook URL, durable billing persistence, and operational webhook monitoring.

## Context

BIZNORYX charges a `$20/month` subscription through Paystack. Hosted checkout alone is not enough for production because subscription state must be updated from provider events, and the webhook URL is publicly reachable.

Paystack's official webhook documentation requires validating the `x-paystack-signature` header as an HMAC-SHA512 signature of the raw event payload signed with the merchant secret key before processing the event. Paystack also retries non-200 webhook deliveries, so the application must handle duplicate events idempotently.

## Decision

Add a Paystack billing boundary in the review application:

- initialize hosted checkout through Paystack when `PAYSTACK_SECRET_KEY` is configured;
- keep a local review checkout path for non-production testing without pretending a real card was charged;
- expose `/api/billing/paystack/webhook`;
- read and verify the raw request body before JSON parsing;
- reject invalid signatures before any subscription mutation;
- apply successful `charge.success` and paid `invoice.update` events as subscription activation/renewal;
- apply `invoice.payment_failed`, `subscription.disable`, and `subscription.not_renew` as subscription status changes;
- record webhook event keys so duplicate deliveries are acknowledged without replaying mutations.

## Consequences

The visible billing flow is now closer to public production behavior and has focused API tests for invalid signatures, valid signed activation, and duplicate delivery. The current route still runs inside the guarded in-memory review runtime. Before real launch, the same contract must be backed by durable billing tables, webhook event storage, Paystack live credentials, public HTTPS deployment, and provider dashboard configuration.
