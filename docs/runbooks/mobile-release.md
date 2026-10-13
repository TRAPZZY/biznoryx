# Mobile Release Runbook

Current scope (12 October 2026): **Android only**, with iOS submission and RevenueCat setup deferred. Follow [android-release.md](android-release.md) for the current release gates and signing preparation. The cross-platform RevenueCat instructions below describe preserved future work, not steps required to enroll accounts now. Missing billing configuration does not make an upload-ready app.

Status: implementation prepared locally; **not approved for submission**. No signed native binaries or real store purchases have been verified. Account enrollment, branding, legal disclosures, platform testing and deployment remain release gates, not optional follow-ups.

## Architecture

The Capacitor 8 applications bundle the existing frontend. They do not load remote executable website code or ship the review backend. Native HTTP connects to `MOBILE_API_ORIGIN` over HTTPS. Sessions use the same eight-hour server sessions and revocation, stored in iOS Keychain/Android Keystore protected storage. Browser cookie CSRF requirements remain unchanged. Native CSV selection uses the system picker; reports use temporary app-cache files and the native share sheet. Manual records use the same server validation and immutable ledger, with a phone record view and encrypted draft recovery.

The billing screen uses RevenueCat's maintained StoreKit/Google Play SDK. The backend fetches verified customer information; it never accepts entitlement booleans or workspace/customer identifiers from the client. A random customer identity belongs to one organization. Receipt hashes prevent reuse across organizations and after closure. Refunds and expired subscriptions revoke access; provider checks are cached for at most 60 seconds. This release does not implement subscription migration between website and stores. Resolve existing website billing before purchasing in a store.

Website checkout, card-trial operations and store reconciliation share an organization billing lock. A live website trial prevents store activation, and a store billing record cannot be replaced by website checkout, including after cancellation. Account cleanup uses persisted billing identity rather than trying to re-verify a RevenueCat subscriber already deleted in an earlier attempt.

## Deploy the Backend First

1. Back up the production database and review migrations `0033` through `0037`, including their rollback restrictions. Apply them in numerical order as the migration owner, then apply bootstrap grants `012` through `014`. Enum changes in `0035` must commit before `0036`. Do not wrap all migrations in one transaction. These scripts were tested only against disposable local databases, not Northflank production.
2. Deploy the updated web API and worker together. Confirm `/readyz`, authenticated account controls and ingestion acceptance. Keep the billing AES encryption key available for existing and closed-checkout refunds; do not rotate it without a recovery migration.
3. Grant the worker scoped object-storage permissions for `GetBucketVersioning`, `ListBucketVersions` and `DeleteObjectVersion` in addition to existing access. Test deletion on your real S3-compatible storage, including versioned buckets and retention/object-lock restrictions. The worker will not mark cleanup complete when provider or storage cleanup fails.
4. Monitor account-deletion requests with status `attention`, which require operator assistance after ten failed attempts. Alert on redacted worker error codes. Validate third-party support/email data deletion procedures and backup expiry. Those operational procedures are not automated by this patch. Approve the retention of anonymous actors, deletion receipts, transaction hashes and sealed refund-recovery records, with documented cleanup requirements.

## Configure Apple, Google and RevenueCat

1. Register/confirm application identifiers `com.biznoryx.app` under your actual developer accounts before the first upload. Change both native projects and Capacitor configuration if your registered identifiers differ.
2. Create monthly auto-renewing subscriptions in App Store Connect and Google Play Console. Configure the seven-day trial in those stores. Trial eligibility and card/payment handling belong to the stores; the app does not promise a trial to an ineligible customer or collect card numbers.
3. Connect both stores to one RevenueCat project using approved server/store credentials. Create the business entitlement and monthly offering. Set restore behavior to **Keep with original App User ID**. Disable family sharing for workspace subscriptions. Verify that refunds/revocations reach RevenueCat promptly through its official store notification integration. Public SDK keys must belong to the same project as the backend secret key.
4. Configure the API/worker secrets: `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_ENTITLEMENT_ID`, `REVENUECAT_APPLE_PRODUCT_IDS`, `REVENUECAT_GOOGLE_PRODUCT_IDS`. Only approved monthly products should be listed. Do not expose the secret API key in the native bundle or Git.
5. Configure public build values from `mobile/.env.example`. The build accepts only HTTPS origins and public `appl_`/`goog_` SDK keys. Missing keys leave purchasing unavailable. Do not submit that unconfigured build.
6. Use dedicated sandbox organizations for testers and reviewers. `REVENUECAT_SANDBOX_ORGANIZATION_IDS` allows real sandbox receipts only for those organization UUIDs. It is not a free-access/reviewer-detection bypass. The production default rejects sandbox purchases for all other businesses.

## Build and Test

Run `npm ci`, `npm run verify`, `npm run test:browser`, `npm audit --omit=dev`, and local isolated PostgreSQL acceptance with `node --env-file=.env.local scripts/entry-trial-acceptance.mjs`. The command called `typecheck` is a JavaScript syntax check, not semantic TypeScript analysis.

Run `npm run mobile:sync` with public SDK keys in the build environment. The generated iOS and Android projects are included in the repository. Android targets API 36 and disables backups/cleartext traffic. iOS targets iOS 15 or later, uses Swift Package Manager and includes a required-reason privacy manifest. Do not enable `server.url` or mixed content in production.

The mobile CI workflow compiles an unsigned Android release bundle and iOS Simulator build. It is added but has not run remotely for this branch. This Windows host has neither Android build tools/JDK nor Xcode, so native compilation has not been demonstrated locally. Use Android Studio with API 36/JDK 21 and macOS with Xcode 26 or later. Resolve/pin transitive native dependencies and inspect the combined SDK privacy manifest in the actual archive. Check current store SDK requirements again before upload.

Replace the generated Capacitor launcher icons and splash artwork with **existing approved BIZNORYX assets**. No new logo was generated. Set unique version/build numbers. Configure release signing securely outside Git, build signed `.aab`/iOS archives, and inspect merged manifests, permissions, privacy reports and native library page-size compatibility.

Test real iPhone/iPad and Android devices: registration, email verification, reset, expired/revoked sessions, workspace switching, file import, phone entry, failed saves, device kill/relaunch and draft recovery, schema/version conflicts, exact submissions, report sharing/cancellation, keyboard and safe areas, back navigation and offline retries. Verify tenant isolation when changing accounts. Encrypted storage/network/share SDK behavior is **not proven by browser tests**.

Exercise real sandbox purchase, eligible/ineligible trial, cancellation while retaining paid access, restore/reinstall, rejected payment, refund, renewal, expiration, duplicate restore, conflicting website billing and account deletion during an active subscription. Confirm no duplicate charge or cross-workspace access. Account deletion must remain available immediately; explain that store billing is cancelled separately.

## Submission and Operations

Publish `/privacy.html`, `/terms.html`, `/account-deletion.html` and working support resources. The provided notices require approval of the actual legal entity, privacy contact, processor agreements, retention and launch countries. They are not a legal compliance certification. Update the account-policy version/acceptance flow after approved changes where required. Complete Apple privacy labels and Google Data safety answers from observed collection, including account/contact identifiers, business uploads, purchases and SDK diagnostics. Do not claim that no data is collected.

Create an isolated reviewer organization on the real backend with explicitly labeled synthetic business records and known expected evidence reports. Give reviewers verified credentials and enough time to complete all flows without access to another customer's data. Supply real-device screenshots, approved branding, subscription disclosures and accurate listing metadata. Fulfill the developer account's beta-testing and identity/contract gates before requesting production access.

Approval is decided by Apple/Google. Do not state that passing automated checks guarantees first-submission approval. Confirm backend revision/migrations, native CI, signed-device tests, billing tests, privacy/retention sign-off, branding, listing and reviewer access before marking this release ready.

## Earlier Local Verification, 12 October 2026

This section records the earlier cross-platform run before the Android-only direction. Current results and remaining gates are recorded in [android-release.md](android-release.md); the earlier local Git/publication status below is historical.

Branch: `codex/mobile-store-readiness`, based on remote main `98a1a7b`. A fresh fetch confirmed that baseline remains current. Changes are local and uncommitted; no push, production migration, deployment or store submission was performed. Synced `sources/` files were untouched.

| Check | Fresh result | Scope |
| --- | --- | --- |
| `npm run verify` | Exit 0; 372 tests, 356 passed, 16 PostgreSQL-dependent tests skipped | Format, lint, JavaScript syntax, migrations, static security checks, tests and web packaging |
| `node --env-file=.env.local scripts/entry-trial-acceptance.mjs` | Exit 0; 16 passed, zero skipped | Disposable PostgreSQL, all migrations/bootstrap, restricted runtime permissions, affected trial/manual-entry/deletion/store boundaries |
| `npm run test:browser` | Exit 0; 35 passed | Chromium desktop/390px journeys; native billing and draft UI use explicitly named contract doubles |
| `npm run mobile:sync` | Exit 0 for Android and iOS | Bundling and native project synchronization, not native compilation; public SDK keys are absent |
| `npm audit` and `npm audit --omit=dev` | Exit 0; zero reported advisories | Installed npm dependency graph, not a security certification or native dependency scan |
| `git diff --check` | Exit 0 | Tracked patch whitespace |
| `npm run release:check` | Exit 1; 14 missing environment settings | This shell was not loaded with production deployment configuration; does not establish Northflank's state |
| `npm run compliance:check` | Exit 1; three approval gates remain | Release readiness, deployment readiness and accountable evidence review were not asserted |

Phone screenshots were inspected for account controls, native billing UI and record entry. A UI-only preview runs at `http://127.0.0.1:4188/#/sign-in` using the existing review runtime and labeled review data. It is not a native-device preview or proof of production subscriptions. Review credentials are `owner@biznoryx.local` / `ReviewPassphrase2026!`; they belong only to this local fixture runtime.

Regression coverage includes a successful production website-checkout request, store/website provider guards, organization billing-lock contention, an unresolved website trial blocking store activation, refund-driven access revocation, receipt identity isolation, late verification refunds after workspace closure and privacy-cleanup recovery after a partial storage failure. Provider behavior in these checks is deterministic test behavior, not real charges.

Required owner inputs remain: developer-account availability, RevenueCat/store product configuration, macOS/Xcode access, approved branding, legal/privacy details and authorization for publishing/deployment. Production migrations `0033` through `0037` and grants `012` through `014` must precede the updated runtime. Do not submit the currently unconfigured native build.

## Official References

- [Apple review requirements](https://developer.apple.com/app-store/review/guidelines/)
- [Google account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
- [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup)
- [RevenueCat customer identities](https://www.revenuecat.com/docs/customers/identifying-customers)
- [RevenueCat server verification schema](https://www.revenuecat.com/docs/api-v1/customer-info-model)
- [RevenueCat Capacitor SDK](https://www.revenuecat.com/docs/getting-started/installation/capacitor)
- [Apple submission SDK requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Google target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [GitHub native build runner availability](https://github.com/actions/runner-images)
