# BIZNORYX Mobile Store Readiness Plan

Audit date: 2026-10-11. Policy research checked on this date; recheck before submission.

Implementation verification updated 2026-10-12. Current results and outstanding release gates are recorded in `docs/runbooks/mobile-release.md`; the baseline findings below are retained as the audit record.

**Verdict: not ready for App Store or Google Play submission.** The findings below record the original audit, not the implementation's current status. Local changes now repair the identified defects and add account deletion, native projects and store subscription integration. Apple/Google subscriptions are confirmed by the user. Signed native compilation, actual store configuration, device testing, production deployment and business/compliance sign-off remain unverified. See `docs/runbooks/mobile-release.md` for the implementation and remaining gates. Neither engineering checks nor policy research can guarantee approval.

## 1. Scope and Evidence

Repository: [TRAPZZY/biznoryx](https://github.com/TRAPZZY/biznoryx).

Audited baseline: [main at 98a1a7b](https://github.com/TRAPZZY/biznoryx/commit/98a1a7b0fcd7afa0aa8be7d67c45d383de93141f). GitHub PRs #4, #5 and #6 have merged. The previous local feature branch was behind main by the public trial pricing and email-verification reminder changes. The audit branch, `codex/mobile-store-readiness`, starts from current remote main.

Source references below are relative to this repository root:

`C:\Users\traph\Documents\Codex\2026-09-28\referenced-chatgpt-conversation-this-is-an\work\biznoryx`

This work inspected the repository, authentication, tenant authorization, ingestion, billing, migrations, browser workflows and official store requirements. It does not establish the current Northflank deployment revision, production migration state, live payment-provider behavior, or native device readiness. No production data or billing was changed. Synced `sources/` files were untouched.

| Requirement or risk | Fresh evidence | Result |
| --- | --- | --- |
| Existing web checks | `npm run verify`: 352 tests, 338 passed, 14 PostgreSQL-dependent tests skipped; formatting, lint, syntax, migration checks, static security checks and web build passed | Partial: skipped database tests and checks' limited scope remain |
| Existing web journeys | `npm run test:browser`: 31 passed, Chromium at desktop and 390px phone widths | Pass within this browser matrix |
| Production dependency advisories | `npm audit --omit=dev`: zero reported vulnerabilities | Pass for the advisory database at audit time; not a security certification |
| Trial timing and cancellation | Deterministic invocation of the actual trial service with a synthetic provider and fractional-second clock | Fail: both provisioning and cancellation return `BILLING_RECONCILIATION_REQUIRED` |
| Rejected upload followed by manual entry | Repository transaction and database source-lock function inspected | Fail by source analysis; PostgreSQL reproduction still required |
| Pending trial checkout recovery | Billing SQL inspected; actual `publicTrial()` invoked | Fail: paid checkout blocked without expiry and pending trial has no exposed cancellation action |
| Native installable release | No iOS/Android projects, signing configuration or native runtime dependencies | Fail |
| Account deletion | Registration exists; no account-deletion route, UI or processing workflow found | Fail for the proposed release with account creation |
| Physical-device and store testing | No native device tests or signed binaries available | Not tested |

The script called `typecheck` checks JavaScript syntax; it is not TypeScript semantic analysis. Static security scripts and compliance manifests do not prove operational controls. The current build copies a review runtime into `dist`; that artifact must not become the production mobile backend.

## 2. Findings to Resolve Before Packaging

### P1: A scheduled trial subscription can remain active after cancellation fails

Location: `src/billing/trial-service.mjs:288`, `:307`, `:365`.

The service rounds its recorded request time upward to the next second, then rejects a provider creation timestamp earlier than that recorded time. With a request at `12:00:00.500`, the persisted request becomes `12:00:01.000`; a provider creation at `12:00:00.500` is rejected even though it is valid. The provider subscription already exists, but its code and cancellation token have not yet been saved. Cancellation tries provisioning reconciliation again and fails before calling the provider's disable operation.

The audit reproduced both errors, a missing persisted subscription code, and zero disable calls. The reproduction used an in-memory repository and synthetic provider; no real payment was created.

Required fix: separate safe provider identity recovery and cancellation from entitlement/time-window validation. Preserve a conservative seven-day entitlement guarantee without rejecting valid provider precision or blocking cancellation. Recover an already-created subscription without creating another. Do not broadly relax customer, plan, amount or authorization binding checks.

Acceptance: fractional and whole-second provider timestamps, delayed confirmation, ambiguous provider results, provider timeout after creation, repeated cancellation, maintenance recovery, and webhook races all have deterministic tests. Confirm cancellation with the provider in a permitted test environment.

### P1: A rejected upload can prevent manual entry for the same month

Location: `src/database/data-ingestion-repository.mjs:365`, `:520`, `:591`; `db/migrations/0031_manual_data_entry.sql:117`, `:157`.

The repository claims the month's `full_file` source mode before validation finishes. It can then persist a rejected run and commit the source reservation. The database trigger skips rejected runs, but the earlier explicit claim remains. A later manual submission encounters `SOURCE_MODE_CONFLICT` despite there being no accepted full-file data.

Required fix: preserve concurrency protection while making the durable source claim reflect accepted data. Add a new migration, if necessary, to repair existing invalid-only reservations after checking for valid uploads and manual submissions. Do not rewrite an applied migration or remove legitimate overlap protection.

Acceptance: rejected file then manual entry succeeds; accepted full file then manual entry remains blocked; simultaneous input modes cannot both commit; rejected-file evidence and raw-data lineage remain available. Run these against PostgreSQL with tenant isolation enforced.

### P1: An abandoned trial can block paid checkout indefinitely

Location: `src/database/billing-repository.mjs:305`; `src/billing/trial-service.mjs:70`; `web-app/trial-billing.js`.

Paid checkout is blocked by an uncanceled, unconverted pending verification record without an expiry condition. The pending trial response exposes no cancel action until provisioning has been attempted or a subscription exists. The UI can offer a paid checkout that the backend rejects.

Required fix: introduce explicit pending-checkout recovery/abandonment and a consistent UI state. Reconcile late verification charges and refunds safely before allowing another billing path; elapsed time alone must not create double billing.

Acceptance: abandon, resume, switch to paid checkout, late successful verification, concurrent actions and late webhooks leave exactly one valid billing path.

### P2: Terminal trial records continue consuming maintenance work

Location: `db/migrations/0032_seven_day_trial.sql:57`; `src/billing/trial-service.mjs:496`, `:529`.

The pending selector includes unconverted rows with no end date, including canceled pre-start records. Maintenance saves an audit event and schedules another check five minutes later even when there is no remaining work. At that cadence, a repeatedly selected record can produce 288 maintenance saves per day. This is a calculated potential cost, not a measured production count.

Required fix: select only actionable work, retain unresolved refunds/cancellation recovery, stop terminal jobs, and use bounded retries and backoff. Adjust the selector through a new migration.

Acceptance: completed terminal records leave the queue, outstanding refunds still run, and an abandoned-checkout backlog cannot starve reminders or cancellation recovery.

### Submission blockers and mobile gaps

| Gap | Code evidence | Required outcome |
| --- | --- | --- |
| No native release project | `package.json`; repository structure | Signed Android App Bundle and iOS archive with reproducible builds |
| Web-only API/session assumptions | `web-app/app.js:189`; `src/webapp/production-app.mjs:2532`; `src/auth/core.mjs` | Authenticated native transport proven on physical devices |
| Paystack purchase navigation | `web-app/trial-billing.js`; public pricing and billing routes | Mobile purchase flow follows the selected store policy path |
| No account deletion | Registration in `src/webapp/production-app.mjs`; no deletion flow found | Working personal-account deletion and appropriate organization closure |
| Limited public policy surface | Inline onboarding terms/privacy in `web-app/app.js`; no dedicated public policy routes found | Reachable privacy, terms, support and deletion-request pages |
| Phone spreadsheet ergonomics | `web-app/data-entry.css:18`, `:27`, `:30` | Record form for phones, larger controls, accessible validation |
| Browser-only report export | `web-app/app.js:4730` onward | Native save/share with correct completion, cancellation and error states |
| No safe-area/native lifecycle handling | `web-app/index.html:5`; stylesheet and manual-entry inspection | Keyboard, notches, back navigation, pause/resume and connectivity handled |
| Unreviewed mobile third-party behavior | Remote 3CX script in `web-app/index.html`; third-party CSP allowances | Verified data inventory and isolated external content |

## 3. Billing Decision

**Planning default: store subscriptions for a public, self-service mobile release.** BIZNORYX currently advertises an individual-accessible subscription and trial. Calling it a business app does not automatically establish an enterprise exemption.

Apple permits some free companions to paid web tools without purchases or external purchase calls to action. Its enterprise provision is for services sold exclusively directly to organizations for employees/students; consumer or single-user sales require in-app purchase under that provision. Reader-app treatment does not describe this analytics product. Regional exceptions require separate analysis. See [Apple purchase rules, sections 3.1.1-3.1.3](https://developer.apple.com/app-store/review/guidelines/).

Google permits consumption-only access to services bought elsewhere. An app selling digital business functionality generally needs Play billing unless an applicable exception/program applies. See [Google's payment policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en) and [consumption-only guidance](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en).

| Release path | Implementation | Decision gate |
| --- | --- | --- |
| Store subscription, default for public self-service sales | Apple in-app subscription and Google Play subscription; website retains Paystack | Configure real store products, pricing, trial eligibility and backend receipt verification |
| Free companion with website billing | Existing customers sign in and use mobile workflows; mobile has no checkout, card verification or external purchase funnel | Establish the actual Apple policy basis for this business model and chosen markets before relying on the exemption |

For store subscriptions, implement a shared provider-neutral entitlement model. Verify transactions on the server, bind purchases to an explicit organization, reject cross-tenant receipt reuse, process authenticated server notifications idempotently, and handle renewals, grace periods, expiry, refunds and revocations. Reinstall/restore must recover the correct entitlement without silently attaching a purchase to a different business.

Prevent a website subscription and store subscription from billing the same organization twice. Provide restore purchases and provider-appropriate subscription management. A store cancellation may disable renewal while access continues until expiry; account deletion is a separate operation.

Configure the proposed seven-day trial through supported store introductory offers. Display store-provided localized prices and eligibility. The mobile trial must not perform the existing Paystack card verification charge/refund sequence. Existing website trial terms remain a separate contract and must match actual provider behavior. Confirm offer capabilities against current [Apple subscription documentation](https://developer.apple.com/app-store/subscriptions/) and [Google subscription documentation](https://developer.android.com/google/play/billing/subscriptions) during implementation.

For a companion release, audit every route and link, including onboarding, Help, pricing, expired access and public landing pages. A hidden checkout button is insufficient if another reachable screen still sends customers into a purchase flow. Apply the behavior to all users of that release, without reviewer-specific switches.

## 4. Architecture in the Existing Workspace

Recommended implementation: Capacitor with bundled production frontend assets, native platform adapters, and the existing remote backend. Keep iOS and Android projects in this repository. Preserve deterministic analytics, tenant ownership, immutable uploads and recurring history on the server.

Apple's section 4.2 requires sufficient utility beyond a repackaged website. Phone record entry, native import and report sharing are the proposed mobile value; adopting Capacitor alone does not establish compliance. See [Apple minimum functionality](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality).

First complete a vertical slice: installable app -> sign in -> authorized organization -> load real metrics -> sign out and revoke session. Validate this on iOS and Android before building additional native screens.

The current frontend uses same-origin API requests and HttpOnly cookies; the production server enforces the website origin and CSRF checks. Packaged assets have a different origin. Choose and document a native transport/session design after testing cookie behavior and platform support. Preserve browser protections; do not solve the difference with wildcard CORS, disabled CSRF, shared static credentials, or bearer tokens in JavaScript local storage. If dedicated mobile credentials are needed, use short-lived server-issued sessions, rotation/revocation and OS-protected storage.

A mobile build must copy only the frontend and reviewed native plugins. Do not bundle the review server, PostgreSQL credentials, S3 credentials, provider secrets or server-only modules. Use an explicit staging/production API configuration and a distinct mobile entry that opens the working application.

Capacitor's remote `server.url` option is intended for live reload rather than production. Package reviewed assets, use HTTPS API calls, and restrict external navigation and native bridge access. See [Capacitor configuration](https://capacitorjs.com/docs/config).

Use maintained official plugins where they fit. Verify plugin versions, platform requirements, permissions and privacy behavior before installing them; avoid speculative SDK downloads during planning. Pin compatible versions and lockfiles when implementation starts. An iOS build requires an appropriate macOS/Xcode environment or macOS CI; this Windows audit did not produce a native binary.

## 5. Phased Implementation and Acceptance

### Phase 1: Repair the existing runtime

Fix the four findings above, with focused tests and new database migrations where needed. Update launch documentation to describe tested runtime behavior accurately. Run the PostgreSQL acceptance suites using an isolated database, including RLS tests with the runtime role rather than a bypassing database owner.

Deliverable: reviewed runtime patch and migration runbook, with billing recovery and ingestion conflict regressions passing. Confirm production migrations and deployed revision separately before mobile testing against production.

### Phase 2: Account Controls and Privacy

Add account settings with reauthentication, an explicit deletion request, progress and completion states. Implement a durable, idempotent deletion workflow with session revocation, processor cleanup and retry handling. Separate a person's account from shared organization records. A last owner needs a clear transfer-or-close-workspace flow; this must not become an indefinite obstacle to personal deletion.

Define retention for personal identifiers, raw uploads, derived metrics, audit records, billing records and backups. Reconcile foreign keys and immutable audit requirements through an explicit anonymization/deletion design. Preserve only records with a documented lawful reason; the compliance manifest's labels do not establish that reason. Notify the person of any retained data and deletion timing. Coordinate billing cancellation and deletion so they cannot leave an unexplained future charge; do not prevent immediate deletion solely because a subscription is active.

Apple requires in-app initiation where account creation is supported; simple deactivation or a mandatory support conversation is insufficient. Google requires both an in-app request path and a functional public web request resource for qualifying apps. See [Apple account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion) and [Google account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).

Publish standalone privacy, terms, support and deletion-request pages under the BIZNORYX domain. Draft them from the implemented data flow and the business's actual contact details, processors and retention policy; obtain appropriate legal review before publishing.

Prepare a field-level inventory covering identity/contact details, organization membership, uploaded customer/business records, payment identifiers, support messages and diagnostics. Inspect 3CX and every native plugin; determine collection, sharing, purpose, linkage, optionality and retention from actual behavior. Match [Apple privacy disclosures](https://developer.apple.com/app-store/app-privacy-details/) and [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) to the shipped release. Backend processing means transport/storage encryption must not be described as end-to-end encryption.

Acceptance: account and organization edge cases tested; other tenants' data untouched; deleted sessions denied; processor failures retried; public deletion URL works after uninstall; disclosures correspond to observed network traffic and storage.

### Phase 3: Native Shell and Secure Authentication

Create the mobile asset build, platform projects, fixed app identifiers and signing configuration. Add application lifecycle, safe-area and keyboard handling. Implement the transport/session design proved in the first vertical slice. Keep external support content outside a privileged native bridge or isolate it appropriately.

Preserve existing email/password authentication initially. Evaluate a Sign in with Apple requirement if a qualifying third-party social login is introduced; the existing own-account login does not itself create that requirement. See [Apple login rules, section 4.8](https://developer.apple.com/app-store/review/guidelines/).

Acceptance: real-device sign-in, verification, password recovery, logout, reinstall behavior, expired session, revoked session, organization switch and unauthorized access all behave correctly. New-app/old-backend and old-app/new-backend compatibility is documented and tested.

### Phase 4: Useful Phone Workflows

Build a compact application navigation using the existing visual style. Preserve working desktop/tablet layouts. The first mobile release should let customers:

- Open their business pulse and verified historical metrics.
- Add a day's records through a clear phone form, review validation and submit into the existing monthly series.
- Import supported files through the system document picker, inspect validation, confirm mappings and follow processing progress.
- Understand evidence reports and save/share an actual PDF through native file/share interfaces.
- Manage account, organization access and the selected billing path.

The 390px screenshot confirms that the current spreadsheet scrolls horizontally and shows only part of a row. Keep the full grid where it is useful, but make individual records practical to enter on a phone. Increase small icon hit areas, handle numeric/date keyboards, prevent obscured submit controls, and verify focus, text enlargement and screen-reader labels. Avoid advertising unsupported file formats.

Make save state explicit. Existing manual entry has delayed autosave and a best-effort save on disposal; it does not establish reliable survival of OS termination or offline edits. Protect draft recovery on pause/resume and interruption. If an offline outbox is included, encrypt local business data, bind it to the user/organization, deduplicate server submission, handle stale versions explicitly and clear it on sign-out/deletion. Do not display offline drafts as accepted metrics.

Report sharing must verify the file was created, distinguish a canceled share from an error, and clean temporary sensitive files. Deep links must validate route/host and must not contain session secrets. Request only permissions needed by a visible feature. Core import/report workflows need no broad storage, contacts, location, microphone or camera access.

Acceptance: entry, correction, import, failed validation, mapping confirmation, background processing, export, share cancellation and network recovery work on physical phones. Business totals remain identical to deterministic backend expectations.

### Phase 5: Implement the Chosen Billing Path

Deliver the store subscription integration described in section 3, or the fully audited companion mode if its policy basis has been established. Keep billing logic separate from rendering and route handling.

Acceptance: platform sandbox purchase, declined payment, trial expiry, renewal, cancellation, restore, refund, revocation, delayed/replayed notifications, duplicate purchases, multiple organizations and website subscribers are tested. No user gains another tenant's paid access or incurs two subscriptions for one intended purchase. Store product configuration and the binary agree.

### Phase 6: Release Builds and Device Testing

Current iOS uploads require Xcode 26 or later and the iOS 26 SDK. Apple's deployment-target floor is iOS 13 or later, but the selected runtime/plugins can require a newer supported minimum. Current new Android apps and updates must target Android 16 / API 36 or higher. Reconfirm at build time. See [Apple submission requirements](https://developer.apple.com/news/upcoming-requirements/) and [Google target SDK requirements](https://developer.android.com/google/play/requirements/target-sdk).

Produce a signed Android App Bundle and signed iOS archive. Configure Apple privacy manifests/approved API reasons and applicable SDK signatures from the dependency inventory; inspect the compiled artifact. See [Apple third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/). Verify native-library compatibility with [Android 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes), release signing, HTTPS-only transport and disabled debug access.

Extend browser checks to WebKit and phone/tablet widths, then test release builds on physical iOS and Android devices. Include a small screen, a notched screen, a current OS, the chosen oldest supported OS, text enlargement, VoiceOver/TalkBack, dark/system appearance if supported, keyboard open, rotation, Android back, long records, cloud-file imports, low connectivity, app termination and resume.

Run isolated PostgreSQL integration tests, provider contract/sandbox tests and native end-to-end tests. Confirm uploaded data reaches the actual worker and verified report, rather than only a review fixture. Verify file-size limits, MIME/content validation, tenant authorization, deletion authorization and replay handling at the real API boundary.

Acceptance: no unresolved P1 findings; all critical journeys pass on both signed builds; crashes, blank screens, duplicate submissions and data loss are addressed. Record device/OS/build identifiers and results with the release candidate.

### Phase 7: Beta and Submission Packet

Use TestFlight and Google Play testing tracks for external feedback. New Google personal accounts created after November 13, 2023 require at least 12 testers continuously opted into a closed test for 14 days before applying for production access. Account type and console requirements remain unconfirmed; meeting the tester requirement does not automatically grant production access. See [Google personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465).

Prepare an isolated reviewer organization on the real backend with clearly identified synthetic business records and known expected reports. Provide stable, preconfigured credentials and sufficient entitlement for the review period. Verification must already be complete, and reviewers must not need a real card or an inaccessible one-time code. Do not expose the development review server publicly or add reviewer-detection logic. Document paths to import, manual entry, report sharing, deletion and billing/restore where applicable. See [Apple complete-review guidance](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review) and [Google app access](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en).

Prepare actual-device screenshots, accurate descriptions, approved app icon and store artwork, category, age/content ratings, support contact, privacy URL, deletion URL, countries and subscription disclosures. Use existing approved branding; creation of a new BIZNORYX logo is a separate decision. Complete developer identity/business verification, contracts and relevant regional disclosures with the authorized Account Holder. If distributing in the EU, verify required trader information. Keep credentials and signing material out of Git.

Acceptance: reviewers can complete every advertised workflow, listing claims match the binary, and privacy/billing/account forms match observed behavior. Backend and worker remain reachable throughout review.

### Phase 8: Controlled Release

After approval, release gradually where the stores support it. Monitor authenticated API failures, ingestion queue latency, crash rates, billing reconciliation, entitlement errors and deletion-job failures. Use redacted diagnostics and documented retention. Maintain backwards-compatible APIs and a backend rollback procedure; mobile users can retain older binaries after a server deployment.

Acceptance: operations ownership, alerting and rollback checks are recorded; monitoring detects failed billing/deletion work before it becomes a customer surprise.

## 6. Business Inputs Still Needed

The user has confirmed Apple/Google subscriptions. Developer account, signing, RevenueCat and launch-market inputs remain unconfirmed.

- Developer account status, account type, legal business owner and launch countries.
- Confirmed: the first mobile release uses Apple/Google subscriptions, including store-managed trial eligibility.
- Confirmed privacy contact, processor agreements and retention/deletion requirements.
- macOS build/CI access, signing access and physical iOS/Android test devices.
- Existing approved app icon/artwork and reviewer access configuration.

An authorized business representative must complete account enrollment, identity verification and binding developer agreements. Engineering can prepare the implementation, release artifacts and review packet while those business tasks proceed.

## 7. Submission Gate

Do not submit until the release owner can supply evidence for each item:

- Runtime findings resolved with regression tests, including PostgreSQL concurrency and tenant-isolation coverage.
- Required migrations applied and actual backend/worker revision verified.
- Native authentication and all critical workflows tested on signed iOS and Android builds.
- Billing policy basis documented and the selected purchase/companion flow checked end to end.
- Account deletion works in-app and through the required web request path.
- Published policies, privacy labels, Data safety answers and SDK manifests match the release.
- Reviewer access, product configuration, screenshots and listing metadata are complete.
- Required beta/account gates are met, with monitoring and recovery procedures ready.

**First implementation slice:** repair trial provisioning/cancellation and the ingestion source reservation, then complete account deletion. These changes benefit the hosted product immediately and remove concrete risks before native packaging begins.
