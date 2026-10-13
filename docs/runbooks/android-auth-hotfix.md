# Android authentication hotfix

## Observed mismatch

On 13 October 2026, read-only HTTP checks confirmed that the live `/app.js`
matches `origin/main` (399e6a5), not the mobile remediation branch. `/healthz`
returned 200. These checks identify the served frontend, not the backend commit
or production database schema. No live accounts were created or changed.
An unauthenticated live `/api/session` probe with a deliberately malformed native
bearer header returned 200/unauthenticated, matching main's behavior of ignoring
Authorization rather than the remediation API's 401 rejection. This confirms a
missing native contract at that boundary, but does not identify a deployed SHA.

An isolated execution of main's production API reproduced the reported message:
native sign-in returned a browser cookie, no `sessionToken`, and the subsequent
cookie-bearing organization request without `X-CSRF-Token` returned 403 with
`Invalid CSRF token.` Registration itself does not require an authenticated CSRF
token in this API. The tester's exact failing endpoint still needs confirmation
from redacted device/network or hosting logs; do not report that as verified.

The installed native transport uses `X-Biznoryx-Client: mobile-v1`, no browser
Origin/fetch metadata, and explicit bearer credentials stored in protected
device storage. This hotfix supplies that contract on top of main, independently
of PR #12's migration-dependent deletion, ingestion and billing additions.

## Security and compatibility

- Native sign-in and email verification return an opaque session token, not a
  cookie. Existing password verification, email challenges and session hashes
  remain unchanged.
- Native authenticated requests require an explicit valid bearer token. An
  ambient cookie is never a substitute. A client marker alone authenticates
  nobody; invalid or browser-context bearer requests are rejected.
- Browser writes retain origin validation, HttpOnly/Secure/SameSite cookies and
  CSRF checks. No arbitrary origins or CORS exceptions are added.
- Native Paystack checkout/verification/management mutations are blocked. This
  hotfix does not configure or enable store subscriptions. That separate
  prerequisite remains outstanding; do not bypass it to enable premium access.
- No database, worker, frontend, Android, versionCode or signing changes are
  required by this patch. Existing versionCode 1's request/response contract is
  compatible; installed-device behavior has not been demonstrated here.

## Deployment gate

The hotfix adds no migration, grant, table or column and uses the identity/session
schema already on main. Local PostgreSQL tests use a newly created disposable
database with main's migrations through 0032 and restricted runtime grants, not
the migrations 0033-0037 required by the full remediation branch. The runner
removes its temporary database afterward. This is not a staging clone upgrade
or an inspection of production migration history.

Before deployment, the Northflank operator must confirm the deployed API commit
and existing runtime schema/privileges, run this commit against staging using the
current runtime role, and verify recovery arrangements. Do not run initial
bootstrap scripts on production or merge/deploy all of PR #12 as this hotfix.
If actual production differs from main or needs a database change, stop and get
explicit approval after reviewing a staging upgrade and recovery test.

Deploy this reviewed hotfix through the actual API service deployment process;
pushing a branch is not deployment. The worker implementation is unchanged and
does not need a new version for this authentication-only patch. Record the
deployed commit, health result and redacted verification evidence. No production
deployment or production database inspection was performed by this task.

## Installed Android verification

Use a disposable business/account and test email inbox, not customer data.

1. Open installed version 1.0/code 1. Register with a fresh test email; confirm
   the verification screen opens, and identify any failing API path from
   redacted logs (never record passwords, cookies, codes or bearer tokens).
2. Verify the emailed code, complete policy acceptance and create a business.
   Confirm there is no CSRF error and no bypass of policy or email verification.
3. Close and reopen the app. Confirm the same account and business restore.
4. Sign out, reopen, and confirm protected data is inaccessible. Sign in again
   and confirm recovery. Test wrong passwords and invalid/expired codes.
5. Verify expiry in staging with a controlled expired test session; confirm
   stale credentials cannot mutate business data and sign-in restores access.
6. Attempt a foreign test business switch; confirm access is denied and the
   active business does not change.
7. Independently test website registration, verification, sign-in, policy
   acceptance and sign-out. Confirm invalid CSRF and cross-origin writes fail.

Live email delivery, staging deployment, the installed tester's build/headers,
device persistence and the final production onboarding flow remain unverified
until this checklist is executed against the deployed fix.

## Fresh engineering checks

- Focused native/browser API, production auth and production security tests:
  24 passed, none failed.
- `npm run db:runtime`: 17 passed, no skips, on main's disposable PostgreSQL
  schema. Real identity/email-challenge repositories and restricted runtime
  permissions exercised; test email delivery captured locally, not sent.
- Playwright customer journeys at 1440px/390px, policy onboarding and password
  recovery: four passed. These UI journeys use the review backend; the production
  authentication contract is exercised separately by the HTTP/PostgreSQL tests.
- Local lint, JavaScript syntax checks, migration/security gates, unit tests and
  web build passed: 350 tests passed, 15 database-dependent tests skipped.
- Local `npm run verify` stopped at the formatter because pre-existing generated
  Android JSON files remain in the shared checkout after changing to main's
  backend-only branch. Those files were not changed or removed. Full verification
  must also pass in the clean GitHub Actions checkout before merging.
