# Notifications-only rollout

The deployed application already includes the in-app inbox and worker. A read-only
production check on 2026-10-26 found all four notification tables, both triggers
and the membership/delivery helpers absent. A code-only redeployment cannot fix
that missing setup. PR 21's broader ownership/billing repair is not part of this
rollout and must not be merged for this purpose.

## Exact scope

`scripts/build-notification-rollout.mjs` packages the existing migration 0033 and
minimum grants for an explicitly supplied, existing application/worker database
role. It does not connect to a database. Its generated SQL runs in one transaction
with a two-second lock timeout and 30-second statement timeout. It refuses an
existing/partial setup, missing prerequisites, an elevated runtime identity,
runtime ownership of the new tables, or runtime permission to activate features.
Use the existing approved migration administrator, not the application role.

It adds four notification tables, their indexes/policies, three helpers, two source
triggers and the actual runtime grants. It records only migration 0033 in the
ledger. Existing business records are not backfilled, deleted or changed. Existing
ingestion and processing tables receive their notification index/triggers only.
No billing/trial repair, role creation, owner changes, migration-history replay,
production secret-group changes or paid-fork resume is included.

## Operator sequence

1. Confirm the deployed API/worker revision and their actual existing runtime
   identities. If they differ, stop and review the two explicit targets rather
   than guessing a role or granting to PUBLIC.
2. Verify an approved production backup/recovery arrangement and the generated
   exact SQL. Existing production-SQL approval requirements remain applicable.
3. Generate the SQL, then apply it through authorized private administrator access:

```sh
node scripts/build-notification-rollout.mjs > notifications-only.sql
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v notification_runtime_role="$EXISTING_RUNTIME_ROLE" -f notifications-only.sql
```

Keep credentials out of command output, screenshots, Git and shared logs. These
shell variables refer to operator-held existing credentials, not new app settings.
The runtime role parameter is quoted as a SQL value and escaped as an identifier.
Never apply this fresh-install package to an existing/partial notification schema.

4. Verify catalogs and worker access. No API rebuild is required for this setup.
5. Leave all organizations disabled initially. Separately authorize one isolated
   test organization, enable its `in_app_updates` flag using the existing rollout
   procedure, and check a synthetic upload's delivery, bell, read state and scope.
6. Roll out more widely only after the scoped live check. Do not claim email or
   Android push delivery; this feature is the existing in-app notification inbox.

Before commit, an error rolls back the additive setup. After commit, disable only
the approved organization's flag if needed; retain notification history and do
not run the destructive down migration. A green endpoint is not notification
delivery proof. The separate trial-maintenance error remains out of scope.

## Focused verification

On 2026-10-26 the generated SQL was applied to a disposable local PostgreSQL 18
database shaped like the observed installation: migration 0033 and the unrelated
0025/0027/0028/0029 repairs were absent. The notification setup succeeded without
applying those repairs or changing ownership of existing tables. The existing
PostgreSQL notification suite passed all eight checks, including delivery,
duplicates/concurrency, read/snooze/preferences, retries and tenant isolation.
Eight focused packaging/API checks, lint, typecheck and build also passed.
These are local results, not proof of live activation or installed-device delivery.
