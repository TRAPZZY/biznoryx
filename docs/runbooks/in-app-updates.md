# In-app Updates: deployment and operations

## Scope

This slice delivers an authenticated, per-user in-app inbox, header bell, filters,
read/unread, bounded snooze, mark-all-read and category preferences. Notifications
come from rejected ingestion runs and successfully processed runs with persisted
verified metric points. Evidence reports are calculated on demand: the message
says data/calculations are ready, not that a PDF has been pre-generated.
No unconfirmed image extraction, financial prediction, email or push is sent.
No external provider or new credentials are needed.

## Prerequisites and safe rollout

Do not run these steps on production without separate authorization. Merging the
PR triggers the existing Northflank main build/deployment, but does not run SQL.

1. Verify backup/recovery, the actual migration ledger and current API/worker SHA.
2. Apply `db/migrations/0033_in_app_updates.sql` in its transaction using the
   authorized migration identity. It creates no enabled feature rows. Existing
   records are not backfilled into fabricated historical notifications.
3. On a fresh database, apply `db/bootstrap/012_in_app_updates_grants.sql` after
   bootstrap role creation. The migration already grants existing named runtime
   roles. Inspect the actual worker role before activation; do not grant BYPASSRLS
   or use a superuser application account.
4. Roll out the reviewed API and worker revision through approved existing
   deployment processes. This task does not authorize a manual worker deployment.
   Confirm the new worker includes `startUpdatesMaintenance`; an old worker will
   safely leave events pending, not deliver them.
5. Approve specific organization activation, using a bound UUID in an operator
   transaction:

```sql
insert into organization_features(organization_id, feature_key, enabled)
values (:organization_id, 'in_app_updates', true)
on conflict (organization_id, feature_key)
do update set enabled = true, updated_at = now();
```

6. In an isolated test organization, process a test source, wait up to 30 seconds,
   check bell/inbox, read with two users, revoke a member and verify isolation.
   Do not use customer files to manufacture release evidence.

Before migration, schema discovery returns disabled without querying absent
tables. With no enabled organization row, UI/inbox delivery/event production are
disabled. Real database, permission and storage errors are not reported as an
empty-success inbox. Auth/CSRF and subscription gates remain independent and
unchanged. Notification deep links cannot grant report or source access.

## Durable delivery and monitoring

Source status and event insert commit atomically. `deliver_source_updates` locks
at most 20 eligible events per maintenance tick (`SKIP LOCKED`), checks active
membership/user/organization plus category preferences, inserts unique recipient
rows and marks delivery in the same transaction. Process death rolls back both.
Provider calls are absent; external exactly-once delivery is not claimed.

Delivery failure retains the outbox, increments attempts, retries with exponential
backoff plus jitter (30 seconds to approximately one hour), and becomes `dead`
after five attempts. Error codes omit document contents and database error text.
Existing inbox rows survive changed preferences. New members are not given old
events created before their membership. Revocation also denies inbox reads.

Operators (not browser clients) should inspect queue health:

```sql
select organization_id, status, count(*), min(created_at) as oldest
from notification_events group by organization_id, status;
select id, organization_id, attempts, last_error_code, created_at
from notification_events where status = 'dead' order by created_at;
```

Investigate persistent `In-app update delivery failed` worker messages, growing
pending age or dead rows. After correcting the cause, an authorized operator can
reset a specific dead event's attempts/status/available_at; the unique
event/recipient key makes replay idempotent. Do not repeatedly reset unexplained
failures or expose document details in monitoring payloads.

Superseding a successful source for the same stream/month marks prior events as
superseded. Existing readers see that label; pending obsolete messages are not
newly delivered. Reading a message does not resolve a business investigation.

## Emergency disable and rollback

Using authorized operator access, set the affected organization's feature row
to `enabled = false` with an updated timestamp. The next request/poll hides the
feature, rejects mutations and stops new event creation/delivery. Historical
evidence remains stored. Already-open request transactions may finish.

The prior Northflank build is the runtime rollback. Additive schema can remain
disabled in place. The `.down.sql` exists for empty/disposable environments; it
deletes notification history and must not be used as a routine production rollback.

## Tests and limits

`tests/updates.test.mjs` covers validation, API scope, browser CSRF/native bearer,
unmigrated runtime and schema-probe failures. `tests/postgres-updates.test.mjs`
uses a disposable admin database only to prepare fixtures and a NOBYPASSRLS role
for application operations. It tests atomic rollback, replay/concurrent delivery,
read/snooze/preference isolation, revoked access, foreign IDs, supersession,
failure exhaustion and targeted recovery. CI explicitly supplies its admin test
URL; do not point it at production. Browser tests use labeled synthetic/test
organizations, exercise desktop/narrow view, keyboard Escape, reduced motion,
failure/retry and account switching.

Physical Android, assistive-technology hardware, push/email, quiet hours and
provider billing/retention are not verified by these browser tests. Browser
visuals do not prove installed WebView download/push behavior. Synthetic OCR
evaluation belongs to the next slice, not this notification release.
