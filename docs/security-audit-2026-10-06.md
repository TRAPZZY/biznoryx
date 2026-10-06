# Security audit and hardening

Scope: the local BIZNORYX checkout at `dd2775d`, confirmed equal to GitHub `origin/main`, its production HTTP runtime, PostgreSQL authorization, billing, ingestion, and browser authentication flows. Public-site inspection used ordinary read-only HTTP requests. No live payment, account, database, or deployment was changed.

## Findings addressed

| Area | Defect | Result |
| --- | --- | --- |
| Sessions | Disabling an organization left its existing sessions usable. | Tenant context marks disabled/missing organizations inaccessible and the repository revokes the session. |
| Authentication | Sign-in could create an old-password session after password reset committed. | User-row locks serialize credential validation, session insertion, reset, and verification. Private credential handoff rejects stale OTP results. |
| Email ownership | First verification activated a password chosen before email ownership was proven. | First verification requires the mailbox owner's chosen password and revokes provisional sessions. Verified-account reauthentication cannot silently change the existing password. |
| CSRF | Cross-site session navigation rotated CSRF state; origin checks ignored the URL scheme. | Cross-site session navigation is rejected. Browser writes compare the full configured origin, including scheme and port. |
| Rate limiting | Fifteen requests from one account blocked unrelated accounts sharing a proxy socket. | Account limits are independent of the larger peer-wide request budget. Client-supplied forwarding headers do not bypass these limits. |
| Redirects | A network-path or absolute request target could replace the HTTPS redirect origin. | Redirects copy only path and query onto the configured application URL. |
| Resource limits | Public auth accepted 32 MiB JSON; small CSVs could expand into excessive synchronous allocations. | Auth accepts 16 KiB, control requests 64 KiB, upload envelopes retain 32 MiB. CSV parsing aborts at 50,000 data rows, 200 columns, 1,000,000 cells, or 1 MiB record data. |
| Raw evidence | Failed duplicate registrations could delete another replica's successfully stored raw bytes. | Request failure/rejection no longer deletes shared immutable objects. |
| Billing permissions | A viewer could start checkout and interrupt paid access. | Checkout and verification/callback require owner capabilities. Storage rejects checkout while an active or non-renewing paid period remains. |
| Provider ownership | Recovery selected subscriptions by shared customer/plan; older lifecycle events could overwrite replacement subscriptions. | Recovery requires exact persisted provider identity or unique direct subscription-to-organization evidence. Lifecycle changes require the current persisted identity under a row lock. |
| Webhooks | Missing organization metadata rejected legitimate subscription failure events. | Verified signatures are checked before resolving the persisted subscription code. Conflicting tenant metadata is rejected; unknown retired identities are acknowledged without mutation. |
| Paid access | Expired active status granted indefinite access; delayed payment events extended dates from receipt time. | Active/non-renewing access requires a future verified paid-through date. Dates derive from the verified payment time; stale periods cannot extend access. |
| Account audit | RLS hid a user's own policy acceptance, keeping durable onboarding blocked. | Self-owned account audit records are readable without exposing other users' account audit history. |
| Validation gate | A file containing one WITH CHECK could conceal another unsafe writable policy. | Each writable policy is checked individually; PostgreSQL SELECT policies are correctly exempt. |
| Shutdown | Graceful shutdown referenced an undefined health-check variable. | Shutdown drains the application's actual health-check instance. |

## Database rollout

Apply these migrations before deploying the new runtime:

1. `0027_disabled_organization_sessions.sql`
2. `0028_billing_provider_identity.sql`
3. `0029_account_audit_self_access.sql`

Existing roles receive the provider lookup grant in migration 0028. New installations also run `db/bootstrap/009_billing_provider_identity_grants.sql`. The lookup is a narrow SECURITY DEFINER function with a fixed search path and no PUBLIC execution grant. Its HTTP caller verifies the Paystack signature first.

Migration 0028 rejects duplicate organization-to-provider subscription bindings. Reconcile any existing duplicate with verified provider evidence before retrying; do not discard tenant records or guess ownership from a shared customer. Legacy subscriptions without a reliable binding must be reconciled through support. Unsafe recovery now fails closed.

Each migration has a rollback file. Rolling back restores the earlier behavior and its associated risk; use rollback only with a coordinated application rollback.

## Verification

- New regression tests reproduced redirect, origin, request-size, session/reset, provisional credential, provider ownership, expiry, CSV amplification, duplicate raw-object cleanup, and durable onboarding failures before their fixes.
- `npm run verify` passed: 271 tests passed, 11 database-dependent tests skipped without a database URL, zero failures. Source checks, migration checks, security checks, and production packaging passed.
- `npm run test:browser` passed all 28 desktop/mobile journeys covering navigation, registration, recovery, onboarding, uploads, reports, and billing history.
- Disposable PostgreSQL databases exercise migrations, restricted-role SQL acceptance, tenant isolation, provider binding uniqueness, stale webhooks, audit visibility, and the existing durable analytics flows.
- All 15 SQL acceptance files passed. The final restricted-role runtime/webhook/policy run passed all four tests. The worker queue test passed separately against its own clean database.
- `npm audit --omit=dev` reported zero published production dependency advisories during this audit. This is also a CI gate.

## Operational limits

This audit cannot establish that a system is impossible to breach. Authenticated live infrastructure, DNS/account administration, backup restoration, database role configuration, production secrets, and real provider delivery were not changed or penetration-tested.

Application authentication counters are process-local. Enforce shared rate/concurrency limits at the deployment gateway across replicas, and configure proxy trust at that gateway rather than trusting arbitrary forwarded headers in the application.

Failed registration may leave an unreferenced immutable raw object. Reconciliation must use tenant-aware database references, retention requirements, and a grace period for in-flight registrations. Do not implement immediate deletion of shared content-addressed keys.

The existing worker database test counts globally queued jobs and requires its own clean database. Running it concurrently with ingestion/analytics tests in one database contaminates that count; isolated execution is required.

Paystack subscription identity and monthly billing behavior were checked against [Subscriptions](https://paystack.com/docs/payments/subscriptions/) and [Webhooks](https://paystack.com/docs/payments/webhooks/) documentation. The public site's existing CSP, HSTS, frame protection, and MIME-sniffing protections were observed, but this does not prove deployed-code equivalence.
