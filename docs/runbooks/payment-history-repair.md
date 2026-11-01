# Payment history storage repair

Use this procedure only for the observed missing `public.billing_payments` table. The existing API already reads and records payments through this table. Creating it does not cancel, renew, activate or change any subscription. No application restart is needed for the SQL repair.

## Preconditions

- Confirm the production database and an existing private administrator connection. Do not expose the database publicly or put credentials in commands, logs, GitHub, or a runtime environment that does not already hold them.
- Confirm a completed recovery snapshot and the existing restore procedure before applying the SQL. A snapshot has not been restore-tested merely because its status is successful.
- Obtain the exact existing API/worker database username from the configured connection privately. Do not assume `biznoryx_app`; production uses a custom role. It must be separate from the migration administrator, non-superuser, non-BYPASSRLS, and unable to inherit the new table's ownership.
- Inspect the current catalog. Stop if the table already exists, the expected prerequisites differ, or the runtime role cannot satisfy those checks. Do not replay other missing migrations or change ownership to force this repair through.

```sql
select current_database(), current_user,
       to_regclass('public.organizations') as organizations,
       to_regtype('public.billing_provider') as provider_type,
       to_regclass('public.billing_payments') as payment_history;
```

## Generate and apply

From a reviewed checkout, generate the schema-only SQL into the ignored evidence directory:

```powershell
New-Item -ItemType Directory -Force test-results | Out-Null
node scripts/build-payment-history-repair.mjs | Set-Content -Encoding utf8 test-results/payment-history-schema-only.sql
```

Use `psql` with the existing private administrator connection configured through the normal secure connection mechanism (for example an existing `PGSERVICE`, without a connection URL on the command line). Supply the non-secret existing runtime username interactively:

```text
\prompt 'Existing production runtime database username: ' payment_history_runtime_role
\i test-results/payment-history-schema-only.sql
```

The script is transactional, has a two-second lock timeout and a thirty-second statement timeout, and refuses an existing or partial table. Errors roll back the repair. It reuses the canonical migration 0025 table/index/RLS definitions. It removes provider-default grants only from the new table where they affect PUBLIC or the selected runtime, then grants that runtime SELECT and INSERT only. Existing customer tables, database defaults, role membership and billing state are untouched.

This deliberately excludes migration 0025's blanket historical backfill: a legacy `completed` checkout is not sufficient evidence of a successful live charge. It does **not** mark 0025 fully applied in the migration ledger. Record this schema-only operation in the deployment evidence; reconcile the ledger separately before any future automated migration replay.

## Verify production

In the same administrator session:

```sql
select relrowsecurity, pg_get_userbyid(relowner) as table_owner
from pg_class where oid = 'public.billing_payments'::regclass;
select policyname, qual, with_check from pg_policies
where schemaname = 'public' and tablename = 'billing_payments';
select has_table_privilege(:'payment_history_runtime_role', 'public.billing_payments', 'SELECT') as can_read,
       has_table_privilege(:'payment_history_runtime_role', 'public.billing_payments', 'INSERT') as can_record,
       has_table_privilege(:'payment_history_runtime_role', 'public.billing_payments', 'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') as excessive_access;
```

Expected: RLS enabled with the organization policy, administrator-owned table, `can_read=true`, `can_record=true`, `excessive_access=false`. Refresh Billing using an authorized account. `/api/billing/history` must return 200 with actual rows or an honest empty list, rather than a missing-table error. Inspect fresh API/worker logs. Do not create a charge or insert a fictional payment to test production.

## Optional historical reconciliation

Existing completed checkout references can be verified against Paystack using the separately reviewed script. Run from an environment already authorized for the private runtime database and live Paystack credentials, using its existing `DATABASE_URL` and `PAYSTACK_SECRET_KEY`. Do not copy or print those values. Start with one confirmed affected organization and a dry run:

```text
node scripts/reconcile-payment-history.mjs --organization-id <confirmed-organization-uuid> --limit 25
```

Only successful **live-mode**, reference/amount/currency/date-matched transactions qualify. Contradictory organization metadata, unknown dates, provider failures and trial references are rejected; test or unknown modes are skipped. Output contains a reference hash and outcome only. Inspect the dry-run result, then repeat with `--apply` to append verified payments through the existing idempotent repository. This never changes subscription access or rewrites an existing conflicting record.

Coverage is limited to the selected organization's most recent completed checkout references (maximum 100). It is not a complete Paystack account import: recurring renewals without a checkout record, incomplete checkouts and older unmatched references require separately verified evidence or provider webhook reconciliation. An empty table after schema repair does not establish that the organization has never paid. Test-mode history is not reconstructed into production live history.

## Recovery

Before commit, any error rolls back the transaction. After commit, retain the append-only payment table and any verified records; do not drop it or restore a whole database over new customer activity as a routine rollback. The prior application revision uses the same table contract. If unexpected behavior appears, pause reconciliation and use the existing verified deployment rollback while investigating. A destructive database restore requires a separately reviewed recovery action.

## Verification evidence

The focused PostgreSQL test uses a disposable PostgreSQL 18 database, a restricted runtime role, inherited provider default grants, and two synthetic organizations. It exercises the actual billing repository, duplicate handling, tenant isolation and preservation of legacy checkouts. Synthetic/local checks do not establish that the production SQL has run or that historical payments have been reconciled.
