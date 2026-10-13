# Backend remediation handoff

## Scope

This branch starts with the existing Capacitor implementation from PR #7 and merges the published resources from main. It does not replace the platform, modify iOS source, deploy production, apply production migrations, configure new billing providers, or generate signing credentials.

The PDF patch extends upload validation, binary raw-object registration and verified worker metrics. Original PDF bytes remain private evidence. It uses existing database columns and needs no additional migration. See `pdf-ingestion.md` for the supported table contract and explicit OCR/format limitations.

Native authentication retains PR #7's server-side bearer transport and the website's cookie/CSRF rules. New fixes remove revoked/expired or invalid cached tokens, validate login credentials before persistence, serialize storage writes, reject stale responses after identity/organization changes, and fail visibly when protected storage fails. Report exports verify the same session before writing/sharing and use isolated cache paths with cleanup. Browser/native token response boundaries and server-selected upload tenants have HTTP contract tests. The native bridge tests use plugin doubles, not an emulator or real device.

## Existing migrations and approvals

The inherited native/deletion/backend implementation still requires migrations 0033 through 0037 and bootstrap grants 012 through 014. Application to Northflank production remains unverified. Do not deploy the updated API or worker against a database missing these migrations.

For a backend release approved by the operator:

1. Inspect the actual deployed migration history and schema. Confirm prerequisites through 0032, the current runtime role, outstanding jobs and existing subscription/deletion states. Do not re-run initial database bootstraps against an established production instance.
2. Prepare and verify a recovery backup. Test the deployed schema's upgrade in a separate staging clone before approving a production change. A successful fresh local database is not evidence of a successful upgrade of the actual production dataset.
3. Apply pending migrations 0033, 0034 and 0035 in sequence using the administrative migration connection and fail-on-error execution. Each file has its own transaction. Wait for 0035 to COMMIT before starting 0036; PostgreSQL cannot use a newly added enum value in that same transaction.
4. Apply 0036, then 0037. Apply grants 012, 013 and 014 to the intended restricted runtime role only after their referenced functions/tables exist. Do not concatenate all five migrations into one outer transaction.
5. Verify enum values, constraints, RLS policies and runtime function/table privileges. Check runtime registration/login/session, upload/worker processing, existing website subscription access and deletion recovery in staging before deploying an approved production change.
6. Deploy matching API and worker versions together. Check health, worker leases, failed jobs and deletion retry status. Re-test the publicly served privacy/deletion resources after deployment; local HTML checks do not establish deployed state.

Rollback restrictions: 0033 does not restore rejected-only source reservations. 0034 requires pending deletions to finish and cannot recover completed erasures. 0035's added enum values are not removed by its down migration. 0036 refuses rollback while store subscriptions exist; retiring transaction records has privacy/ownership implications. 0037 refuses rollback while refund recovery remains unresolved. Prefer a reviewed forward fix rather than a destructive rollback.

## Checks and remaining limits

Local verification on 12 October 2026 (final-commit CI results are recorded in PR #12):

- `npm run verify`: passed formatting, lint, JavaScript syntax, migration/security checks and the web build; 389 tests passed, 18 database-dependent tests skipped, none failed.
- `npm run test:browser`: 45 journeys passed, including the oversized-PDF preflight regression and desktop/phone screenshots. These use the review backend and controlled responses, not production accounts or physical Android devices.
- `node --env-file=.env.local scripts/entry-trial-acceptance.mjs`: 18 disposable PostgreSQL tests passed with no skips, including retention cleanup and restricted-role rejection.
- `npm run db:runtime`: 12 durable-runtime/helper tests passed with no skips against disposable local PostgreSQL.
- `npm run mobile:android:sync`: frontend bundle and Android asset/plugin sync passed. This is not native compilation.
- `npm audit --audit-level=high`: zero reported vulnerabilities.

The disposable local acceptance runner applies the complete migration and grant sequence in filename order through separate psql calls, runs SQL acceptance, then exercises deletion, native bearer/cookie isolation, manual entries, existing billing boundaries, PDF persistence and retention. Its 18 tests passed on 12 October 2026, with no skips; the temporary databases were removed. It does not contact production storage or payment providers.

Read-only requests to the two production public URLs failed at DNS resolution in this environment (`EAI_AGAIN`/`ENOTFOUND`). This does not establish that the pages are unavailable to users; their current deployed contents remain unverified.

The operator supplied and approved complete launcher/splash artwork; Android references an unchanged copy of that PNG. iOS assets are untouched. Proposed 30-day deletion/backups and 90-day operational-log targets are documented in `retention-controls.md`, with an opt-in maintenance command and explicit provider/configuration gaps. They are not published commitments. Public pages preserve the current support-assisted process and do not promise unverified automated production deletion. Mobile privacy disclosures need to be reconciled with the final enabled SDK/provider configuration before any distribution.

RevenueCat keys/products are not configured. Existing website billing is preserved and no live purchase, restore or provider synchronization was performed. Browser billing tests are UI contracts with controlled responses, not proof of store transactions. No publisher configuration or signing secrets were requested.

Android asset/plugin sync is available locally; Java, Android SDK and adb were not found on configured paths in this environment. GitHub CI compiled the remediation checkpoint and inspected the compiled debug manifest and dependency inventory: application ID `com.biznoryx.app`, version code 1/name 1.0, minimum SDK 24, target/compile SDK 36, backups and cleartext disabled. The merged debug manifest requested Internet, network-state, billing and the app's signature-protected receiver permission, with no advertising-ID permission. Final-commit CI evidence is recorded in PR #12. Compiling the instrumentation test APK is not executing instrumentation. Local Gradle compilation, physical-device instrumentation/behavior, final release-artifact verification and real purchase tests remain unverified. No signed release bundle has been produced.
