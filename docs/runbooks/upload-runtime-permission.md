# Upload runtime permission repair

Production upload attempts on October 27 failed with PostgreSQL 42501:
`permission denied for function claim_ingestion_period_source`.
Migration 0031 and bootstrap 010 grant this helper to `biznoryx_app`, but the
Northflank API uses a different existing restricted role. The helper and required
source-table privileges already exist. Do not replay 0031 or remove its guard.

Generate a reviewed, atomic permission-only package:

```sh
node scripts/build-ingestion-runtime-grant.mjs > ingestion-runtime-grant.sql
psql "$EXISTING_MIGRATION_ADMIN_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v ingestion_runtime_role="$EXISTING_API_RUNTIME_ROLE" -f ingestion-runtime-grant.sql
```

Use the existing administrator through the established private connection. Never
commit credentials or place them in terminal history. Confirm the administrator
and API point to the same database. Derive the runtime identity from the API's
existing connection, not from a guessed role name.

The package verifies the existing invoker function against migration 0031, its
fixed search path, absence of PUBLIC execution, required table access and forced
RLS. It grants only EXECUTE on that exact function to the existing restricted
role. It does not change schemas, data, function definitions, role memberships,
ownership, billing or notification activation. Reapplying it is idempotent.

Before applying, capture whether the runtime already has EXECUTE. Rehearse using
`RUNTIME_GRANT_TEST_ADMIN_DATABASE_URL` against an empty disposable PostgreSQL
database and `node --test tests/ingestion-runtime-grant.test.mjs`. The test first
reproduces the missing permission, then checks both input modes, conflicts and
foreign/missing tenant context after repair. No customer data is required.

After applying, recheck through the API runtime, validate health and retry the
original upload through the application. A transaction-rollback repository probe
can verify registration without persisting test records or uploading objects.
If rollback is needed and this repair added the grant, the administrator can
REVOKE EXECUTE on this exact function from the same role. This restores the prior
broken upload state, so use it only for a demonstrated regression. No application
restart or database restore is required for this permission-only change.
