# Automatic business notifications

## Behavior

All existing active businesses receive the current in-app Updates feature. New
active businesses receive it in the same transaction that creates the business,
including when created by the restricted application role. No separate user
profile opt-in is required. Personal category opt-outs, active membership checks,
RLS, disabled-account checks and the existing delivery worker remain unchanged.
No old uploads are backfilled, no synthetic reports are created, and email/push
providers are not involved.

## Deployment

Apply migration 0034 only after the notification-only 0033 schema and restricted
runtime grants are verified. Use the existing migration administrator; do not
give the API role feature-flag mutation rights. Verify the backup/recovery
arrangement and current API/worker revision first.

The migration adds one notification initializer and an organization-insert
trigger, then enables missing/disabled notification flags for active businesses.
It does not change organization records, billing, trials, memberships, secrets,
database-wide default privileges or ownership. Its transaction uses a two-second
lock timeout and 30-second statement timeout. Record only its filename in the
existing migration ledger, in the same administrator transaction.

Verify that every active organization has an enabled `in_app_updates` row,
preferences are unchanged, the initializer is SECURITY DEFINER with its fixed
search path and trusted owner, and the runtime still cannot write feature flags.
The production browser should show the bell/inbox for an authorized active
business. The next qualifying upload generates an alert after processing and
worker delivery; a green endpoint or empty inbox is not an end-to-end delivery
test.

## Recovery

Before commit, an error rolls back the whole activation. After commit, an
authorized operator can disable a specific business flag without deleting
notification history. The down migration stops automatic initialization of
future businesses but deliberately preserves existing flags and inbox records.
Do not run migration 0033's destructive down migration on production.

## Verification

The PostgreSQL rollout test covers an existing disabled flag, missing defaults,
disabled businesses, personal opt-outs, restricted-role creation, unchanged
existing ACLs, no historical events and business-creation rollback. The existing
delivery suite covers automatic availability, operator disable, read/snooze,
category opt-out, replay, concurrency, retries and cross-tenant isolation.
