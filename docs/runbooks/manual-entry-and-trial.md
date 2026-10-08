# Manual entry and seven-day trial rollout

## Northflank deployment order

1. Back up the production database. Keep the current runtime running while applying the additive migrations.
2. Apply `db/migrations/0031_manual_data_entry.sql`, then `db/migrations/0032_seven_day_trial.sql` once with the migration/admin connection, after migration 0030. Do not replay historical migrations against a populated database.
3. Existing `biznoryx_app` installations receive the required grants in the migrations. Fresh installations must run bootstrap files through `011_trial_billing_grants.sql` after the migrations. Do not use the administrator connection for the application.
4. Configure both the web service and worker with the trial settings below. Keep both services on the same settings and commit. The existing private S3 storage and ingestion worker must remain enabled.
5. Merge the reviewed branch and deploy the web runtime and worker together. Keep the signed Paystack webhook pointed at the existing application webhook endpoint.
6. Verify the flows with a Paystack test account and a separate test business before enabling live trial checkout. Live provider behavior, bank refund timing, and Northflank configuration cannot be proven by local fixtures.

### Trial configuration

Use the existing `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_CODE`, NGN monthly plan settings, and `BIZNORYX_PUBLIC_URL=https://biznoryx.com`.

- `BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR`: an explicitly approved positive NGN amount in kobo, below the monthly plan amount. Confirm the amount is accepted by Paystack. It is disclosed before checkout, charged for card tokenization, and submitted for refund after successful verification. This is not a zero-charge checkout.
- `BIZNORYX_BILLING_ENCRYPTION_KEY`: a separate base64-encoded, random 32-byte encryption key. Generate locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, then enter it as a Northflank secret for both services. Never commit or log it. Back it up securely; changing it without re-encrypting existing authorizations breaks reconciliation and cancellation.
- Keep the existing `RESEND_API_KEY` and `BIZNORYX_EMAIL_FROM` (or `RESEND_FROM`) configured on the worker for the reminder sent during the final 24 hours of a trial.

Missing trial settings disable new trial checkout without disabling ordinary paid checkout. Do not remove the key, provider credentials, or maintenance worker while trials or unresolved refunds exist. Keep the subscribed Paystack plan and price unchanged during already-consented trials.

Only organization owners can start, verify, cancel, or update trial billing. Paystack hosts card entry; BIZNORYX does not receive or store card numbers or CVVs. Reusable provider authorization and cancellation tokens are encrypted. The seven-day access window starts after provider subscription creation is confirmed; the scheduled first payment is shortly after that window, with its exact timestamp displayed. Card verification and scheduled-subscription events cannot activate a paid subscription. A separately verified qualifying subscription payment is required.

## Manual data behavior

The existing Data & uploads page now has Upload file and Enter data modes. Drafts are versioned in PostgreSQL, validation is server-side, and the saved validation receipt is required for submission. Editing or saving after validation invalidates that receipt. The editor supports tab-separated spreadsheet paste, row edits, column ordering, undo/redo, and saved drafts.

Each submission is an immutable batch. Later daily entries rebuild the same series/month snapshot from the latest revision of each batch; identical legitimate records are not silently deduplicated. Corrections preserve the original submission and replace only that batch's contribution. The cumulative CSV is retained in private immutable storage and processed by the existing durable metric pipeline. A second submission must wait until the preceding monthly snapshot finishes processing.

File uploads and manual batches cannot both claim the same series/month. This prevents accidental double-counting. The UI asks users to keep the established source or use a separate series; it does not silently merge conflicting full reports. Existing CSV/XLSX/JSON review behavior and production CSV ingestion remain unchanged.

Manual months stay explicitly partial, even when entered dates reach both month boundaries. Verified totals are available, but full-month growth/decline findings and dashboard percentage comparisons are withheld for partial periods. There is no implicit month-close or automatic completeness claim in this patch.

## Recovery and operator checks

- A failed raw-storage/database delivery retains its immutable reservation. Reload the saved draft, validate it, and retry submission. Its original identity and job are reused. Do not create another batch to retry the same records.
- Trial provisioning/refund intents are persisted before non-idempotent provider calls. Lost-response recovery queries existing provider objects; it does not blindly repeat charges, subscription creation, or refunds. Ambiguous provider results need operator reconciliation.
- Cancellation remains pending until Paystack confirms it. Confirmed cancellation stops scheduled trial billing while verified trial access continues until its original expiry. Once converted, use the existing paid-subscription cancellation flow.
- A failed first subscription payment exposes a Paystack-hosted payment update link. BIZNORYX does not locally retry debit attempts or extend the trial. Paystack does not automatically retry failed subscription charges; updating a card is not a promise of immediate reactivation.
- Monitor worker errors, pending `cancelStatus`, `provisionStatus`, and `refundStatus`, and append-only `billing_trial_audit` events using operator-only tooling. Refunds with `failed` or `needs-attention` states require provider follow-up. Never manually grant access just to clear an error.

## Verification

Run `npm run verify` and `npm run test:browser`. With local Docker PostgreSQL and the existing `.env.local` runtime password, run `node --env-file=.env.local scripts/entry-trial-acceptance.mjs`. It creates disposable databases, runs the existing SQL acceptance suite, and checks real runtime permissions, RLS, draft concurrency, cumulative decimals, correction history, recovery, overlap, and trial constraints. The broader pipeline check is `node --env-file=.env.local scripts/production-pipeline-acceptance.mjs`.

Provider tests use synthetic, deterministic Paystack fixtures, never real charges. Browser trial tests inject billing states to verify disclosures, recovery, and confirmation UI; PostgreSQL acceptance independently verifies durable records and tenant boundaries.

## Rollback

Prefer rolling back the runtime while retaining additive tables and evidence. Before retiring trial handling, reconcile or cancel outstanding scheduled provider subscriptions and finish refunds. Never turn off the only cancellation/recovery path while scheduled billing remains live.

`0032_seven_day_trial.down.sql` revokes runtime access but preserves trial evidence; only use it after provider obligations are resolved. `0031_manual_data_entry.down.sql` is destructive and is only suitable for an unused installation. It refuses to run after any draft/submission evidence exists. Do not remove immutable business history from a populated production database.

Official provider references: [free trials](https://support.paystack.com/en/articles/2125186), [subscription API](https://paystack.com/docs/api/subscription/), [subscription behavior and events](https://paystack.com/docs/payments/subscriptions/).
