# Android-Only Release Preparation

Updated 12 October 2026. This is a preparation branch, not an approved or submitted Google Play release. iOS release work and RevenueCat account configuration are deferred. Existing iOS source is preserved for a later release.

## Required Decisions

- Confirm the legal operator, public privacy/support contact, launch countries and actual production backup, log, support-message and recovery-record retention. The detailed policy is a factual technical draft, not legal sign-off. Publish only after the operator has reviewed it and adopted a concrete retention procedure. Never enter a fabricated retention duration.
- Confirm the Android package identifier `com.biznoryx.app` before the first upload. Changing it later creates a different app.
- Decide between an existing-subscriber, consumption-only first release and direct Google Play Billing. The previous store implementation uses RevenueCat; missing SDK keys are **not** a complete Android billing solution. Do not submit the present unconfigured store billing screen. Direct Google billing needs native purchase handling plus trusted server verification, lifecycle notifications and real test transactions. Consumption-only needs an explicit UI/build change removing purchase controls and all direct or indirect alternative-payment links. Do not quietly substitute this for the previously requested in-app subscriptions.
- Obtain approved existing launcher/splash assets. The generated Capacitor defaults are not approved BIZNORYX branding. No new logo has been generated.

## Backend and Public URLs

Follow the backend migration, grants, worker and storage instructions in [mobile-release.md](mobile-release.md). Migrations `0033`-`0037` and bootstrap `012`-`014` have not been applied to Northflank by this task. Migration `0035` must commit before `0036`.

Deploy the approved policy and working account-deletion runtime before entering their URLs in the listing:

- Privacy policy: `https://biznoryx.com/privacy.html`
- Account deletion: `https://biznoryx.com/account-deletion.html`

On 12 October 2026, the production privacy URL returned HTTP 404. A branch push does not make it live. After deployment, verify both pages anonymously over HTTPS, without login, country restrictions or PDF downloads. The policy has its own local stylesheet and loads no scripts or remote resources itself. Its support link opens the separately configured support service.

The new privacy version is `2026-10-12`. Earlier privacy acknowledgements become outdated; terms, guide and data-authority versions remain unchanged. Account deletion must remain accessible without accepting the new policy.

## Build and Signing

Run `npm ci`, `npm run verify`, `npm run test:browser`, and the isolated PostgreSQL acceptance described in the shared runbook. Run `npm run mobile:android:sync` to synchronize only Android. `mobile:sync` remains available for future cross-platform work.

The Android CI job uses JDK 21, API 36 and builds a debug APK and an unsigned release AAB. The uploaded check artifact is explicitly **not for Play upload**. iOS compilation is not run in this release workflow. The unconfigured billing gate remains even if compilation passes.

Release signing reads these four environment values together:

| Setting | Value |
| --- | --- |
| `ANDROID_UPLOAD_KEYSTORE_PATH` | Absolute path to the private upload keystore outside this repository |
| `ANDROID_UPLOAD_STORE_PASSWORD` | Keystore password, supplied through protected secret storage |
| `ANDROID_UPLOAD_KEY_ALIAS` | Existing upload-key alias |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Upload-key password, supplied through protected secret storage |

Run `./gradlew :app:bundleSignedRelease --no-daemon` from `android` only after the preceding gates are resolved and Android SDK/JDK are available. Partial signing settings or a nonexistent keystore stop the build. `bundleSignedRelease` fails when signing is absent instead of passing off an unsigned bundle as upload-ready. Keystores and signing passwords must never be committed, printed in logs, or pasted into chat. This task does not generate or enroll a publisher's upload key or operate Play Console. An authorized, eligible publisher must manage the publishing account, signing enrollment, declarations and submission.

Verify the AAB's signature, application ID, version, merged manifest, permissions, SDK inventory and 16 KB native-library page-size support. Increase versionCode for subsequent uploads. Run real Android-device tests for authentication, keyboard/back navigation, protected draft recovery, CSV picker, offline errors, report sharing, account switching, deletion and the chosen billing flow. Browser contract doubles do not verify Android hardware or store payment behavior.

## Data Safety Preparation

Use the source inventory below as a starting point, not a pre-filled legal attestation. Reconcile it with the final merged manifest, SDK traffic, infrastructure logs and enabled production configuration. Google distinguishes collection from sharing, and some transfers to contracted service providers or at the user's request may qualify for exceptions; the publisher must assess those definitions.

| Candidate Google data category | Observed source and purpose | Required check |
| --- | --- | --- |
| Personal info: name, email, user IDs | Authentication, invitations, organization roles, deletion verification | Required account fields and provider access |
| Financial info: purchase history; other financial info where records identify people | Subscription states and submitted sales/transaction records | Final billing mode; arbitrary business CSV contents; no claim of collecting full card details |
| Files and docs | User-selected CSV uploads, submitted data and user-requested report exports | Server retention, sharing destinations and object-storage deletion |
| App activity and other user-generated content | Drafts, business configuration, actions, reports and support messages | Actual stored fields, required/optional status and purposes |
| App info/performance: diagnostics, if collected | Processing failures and provider/hosting logs | Actual logs and final SDK diagnostics; do not declare crash reporting absent without testing |
| Device or other IDs, if collected by enabled SDKs | Final native SDK and support/hosting inventory | Check installed SDK traffic; organization UUID is not a hardware identifier |

The reviewed business workflows do not request contacts, SMS, microphone, camera or precise location. That does not replace inspection of the final merged permission manifest. No advertising SDK or advertising workflow has been added by this patch. Do not declare that no user data is collected.

## Final Publisher Gates

Provide accurate app-access instructions using a dedicated reviewer workspace with labeled synthetic business data, not a production customer's records. Complete content rating, target audience, ads and Data safety declarations from the final app. Use screenshots from real rendered Android screens and truthful store metadata. Follow any testing and production-access requirements shown for the publisher account; do not assert they have been completed merely because enrollment was paid.

Submission remains blocked until billing scope, operator/privacy details and retention, deployed migrations/runtime, public URLs, approved assets, signed native artifact, real-device testing and publisher declarations are verified. Google decides acceptance; passing automated checks cannot guarantee first-submission approval.

## Fresh Local Verification

- `npm run verify`: exit 0; 374 tests, 358 passed, 16 PostgreSQL-dependent tests skipped. Formatting, lint, JavaScript syntax, migrations, static security checks and web packaging passed. The repository's `typecheck` command checks JavaScript syntax, not semantic TypeScript types.
- `npm run test:browser`: exit 0; all 36 Chromium journeys passed, including public policy access, no horizontal overflow at 390px/1440px, new privacy acknowledgement, account deletion and existing business workflows. Native contract tests use explicit doubles, not Android hardware.
- `npm run mobile:android:sync`: exit 0. Bundling and Android project sync passed. The store SDK remains unconfigured and purchasing unavailable; sync is not native compilation.
- `npm audit`: exit 0; no reported npm advisories. This is not a native SDK or security certification.
- Fresh local PostgreSQL acceptance initially could not start because Docker's engine was unavailable. After the engine and existing local PostgreSQL container were started, `node --env-file=.env.local scripts/entry-trial-acceptance.mjs` passed all 16 tests with zero skips against disposable databases and restricted runtime roles. The PR's full PostgreSQL CI jobs must also pass before merge.
- Local policy preview: `http://127.0.0.1:4188/privacy.html`, backed by the existing review runtime. It is not the public production URL.
- `release:check` and `compliance:check` remain blocked in this shell: production settings were not loaded and accountable release/deployment/privacy approval has not been asserted. Missing local environment values do not establish Northflank's configuration.

Android CI run `38251349325` passed on commit `9f0253a`: debug APK, Android test package and unsigned release AAB compiled and the check-build artifact was uploaded. Device tests were compiled, not executed. The initial SDK setup failed because the older action requested Google's retired `tools` package; updated setup and an explicit package list resolved that failure.

The downloaded APK and AAB were inspected as ZIP archives; neither contains `.so` native-library files. This removes ELF shared-library alignment from the current dependency inventory, but does not replace real-device compatibility tests. The release AAB has no JAR signature entries and is not ready for Play upload.

The first remote browser run hit the unchanged review runtime's authentication rate limit because separate tests shared one fast-running backend. Tests now share the existing manual-entry test pattern: each test owns a real review backend and its authentication quota. No production or review rate limit was relaxed. The fresh local full run passed all 36 journeys; a new regression test verifies that attempt 16 is still rate-limited and a separate runtime keeps its own quota. Remote CI must verify the integrated change as well.

No production migration, runtime deployment, store enrollment, purchase or submission was performed by this task. PR: [Android preparation #7](https://github.com/TRAPZZY/biznoryx/pull/7), kept in draft until the gates above are resolved.

## Official References

- [Google user data and privacy policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en)
- [Google payment and consumption-only policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en)
- [Google account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
- [Google Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
- [Android app signing](https://developer.android.com/studio/publish/app-signing)
- [Android 16 KB page-size support](https://developer.android.com/guide/practices/page-sizes)
