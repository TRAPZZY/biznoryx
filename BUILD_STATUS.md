# BIZNORYX Build Status

Current phase: **Production runtime and launch integration**

Public production: **not ready**

## Current Evidence Takes Precedence

The historical phase tables below describe repository-level implementation and acceptance evidence; they do not establish a deployed SaaS. The local review command (`npm run app`) uses process-memory stores and must not receive real customer data. The production command (`npm run app:production`) uses the PostgreSQL-backed HTTP application and refuses startup in production unless its environment passes validation. Its readiness endpoint checks PostgreSQL, configured object storage, and a fresh durable worker heartbeat.

The application includes PostgreSQL repositories for identity and sessions, email verification and password recovery, onboarding, ingestion, verified metrics, comparisons, findings, actions and outcomes, reports, billing, and audit activity. Production raw uploads use the S3-compatible object-storage adapter, and `scripts/production-worker.mjs` runs durable metric/comparison/finding jobs. Paystack checkout and signed webhook handling are implemented behind production configuration. The dashboard uses verified data rather than fabricated preview metrics.

The local review runtime and production runtime are separate on purpose. Production email delivery uses Resend when configured; storage, worker, and billing connections use production environment configuration. A code path or repository acceptance test does not prove that production credentials, provider accounts, web/worker services, backups, DNS/TLS, monitoring, or deployment automation exist. Those provider and operator checks remain launch blockers until configured and verified in the target environment.

Authentication endpoints have an application-level throttle of 15 requests per minute per remote socket address. This counter is process-local and is not a distributed limit across web replicas or a general API abuse control. Configure shared edge/WAF rate limits for authentication and upload/API traffic in production; ensure the platform's trusted-proxy behavior is understood before using forwarded client-IP headers.

The application refuses to start this in-memory runtime when NODE_ENV=production. Do not use real customer data in the local review server.

Latest local evidence:

```text
npm run verify                  # passed, full Node suite plus format/lint/typecheck/migration/security/build checks
npm run test:browser            # passed, 23/23 desktop and mobile browser journeys
npm audit --omit=dev            # passed, 0 production dependency vulnerabilities
npm run db:runtime              # passed, 12/12 PostgreSQL runtime tests against a disposable PostgreSQL 18 database
npm run db:acceptance           # not run in this shell: DATABASE_URL is not configured
```

The runtime acceptance creates and drops its own database. The separate RLS SQL acceptance command requires an explicitly configured target URL and must be run against a disposable clean database before deployment.

## Durable Runtime Integration

| Gate | Status | Evidence |
|---|---|---|
| PostgreSQL connection pooling | Passed | `src/database/postgres.mjs` creates a bounded pool with connection and idle timeouts. |
| Transaction-scoped RLS context | Passed | Tenant and actor settings are local to one checked-out transaction client. |
| Database-backed identity and sessions | Passed | Registration, sign-in, session lookup, CSRF rotation and revocation use PostgreSQL records. |
| Durable organizations and switching | Passed | Organization creation preallocates the tenant ID and writes under matching RLS context; switching requires active membership. |
| Restart persistence | Passed | A fresh repository instance authenticates and discovers records created earlier in the live database test. |
| Cross-tenant organization denial | Passed | Live PostgreSQL acceptance rejects switching to an outsider organization and limits organization reads through RLS. |
| Case-insensitive account identity | Passed | A unique lower-cased email index matches application normalization. |
| Audit visibility hardening | Passed | Runtime reads require tenant context; global identity audit writes require matching actor context; runtime audit updates are revoked. |
| Tenant-switch request race | Passed | Mutations bind to the organization authorized at request start; a slow-upload regression test covers concurrent switching. |
| CI dependency installation | Passed | CI installs the lockfile before verification and runs durable runtime behavior against PostgreSQL. |
| Database acceptance target safety | Passed | `scripts/run-postgres-acceptance.mjs` now honors `DATABASE_URL` in both host-psql and Docker fallback modes; local verification used a disposable clean database. |
| HTTP runtime backed by PostgreSQL | In progress | The public HTTP routes still use the guarded review runtime. |
| Private immutable object storage | Blocked | Provider-neutral contract and production-backed implementation are not complete. |
| Durable ingestion/metric workers | Blocked | Database control-plane tables exist, but no production worker executable is connected. |

## Durable Billing Persistence

Status: **implemented and live-database verified**

| Gate | Status | Evidence |
|---|---|---|
| Billing subscription schema | Passed | `db/migrations/0016_billing_subscriptions_paystack_webhooks.sql` creates tenant-owned subscription, checkout, and webhook event tables. |
| Migration rollback | Passed | `db/migrations/0016_billing_subscriptions_paystack_webhooks.down.sql` drops policies, tables, and billing enums safely. |
| RLS policies | Passed | Billing tables use `app.current_organization_id` policies with explicit `WITH CHECK`. |
| Runtime role grants | Passed | `db/bootstrap/001_runtime_role.sql` grants the restricted `biznoryx_app` role access to billing tables without bypassing RLS. |
| Database acceptance script | Added | `db/acceptance/phase18_billing_paystack_acceptance.sql` proves tenant visibility, cross-tenant write denial, and default-deny behavior when PostgreSQL is available. |
| Durable repository seam | Added | `src/database/billing-repository.mjs` provides subscription creation, checkout recording, signed-webhook event persistence, subscription action application, and duplicate event detection. |
| Verification | Passed | `npm run db:runtime` verified persisted billing checkout and idempotent webhook behavior through the PostgreSQL repository, and `npm run db:acceptance` verified billing RLS tenant visibility, cross-tenant write denial, and default-deny behavior against PostgreSQL 18. |

## Workspace Note

The requested source path `/mnt/data/biznoryx-production` was not available in this Windows Codex workspace, and no Git checkout or `BUILD_STATUS.md` existed under the project directory. The synced `sources/` folder is read-only reference material. The production repository was therefore reconstructed in this workspace instead of modifying an existing checkout.

## Phase 1 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Inspect existing repository | Completed with caveat | No existing repository was present; only `AGENTS.md` and read-only blueprint source were available, so the production repository was reconstructed in this workspace. |
| Real authentication/session handling | Implemented | `src/auth/core.mjs` includes password hashing, session issuance, secure cookie policy, CSRF validation, expiry, and revocation. |
| Organizations and switching | Implemented | `OrganizationService.createOrganization` and `switchOrganization` require active membership. |
| Membership/invitation lifecycle | Implemented | Invitation creation, acceptance, expiry, single-use consumption, and audit events are implemented. |
| Capability-based authorization | Implemented | `CAPABILITIES`, role capability map, `AuthorizationService.requireCapability`, and service-boundary checks for member/invitation mutations. |
| Server-side authorization and IDOR/BOLA protection | Tested | `tests/phase1-authz.test.mjs` verifies cross-organization denial, disabled-member revocation, service-boundary authorization, and invitation email binding. |
| Organization-aware transactions | Implemented | `withOrganizationTransaction` sets local `app.current_organization_id` and `app.current_user_id`. |
| PostgreSQL RLS integration | Implemented | `db/migrations/0001_foundation.sql` and `0002_phase1_identity_org_auth.sql`. |
| Runtime database role | Implemented | `db/bootstrap/001_runtime_role.sql` creates least-privilege `biznoryx_app` with `NOBYPASSRLS`; local verifiers reject missing `NOBYPASSRLS` or broad grants. |
| Audit logging | Implemented | Audit records are written for sign-in, sign-out, organization creation/switching, invitations, and member changes. |
| Protected app shell | Implemented | `src/server/app-shell.mjs` returns authenticated shell states and redirects unauthenticated sessions. |
| Loading/empty/error/disabled states | Implemented | App shell state model includes `loading`, `empty`, `ready`, `disabled`, and `error`. |
| Migration and rollback safety | Implemented | Forward and rollback migrations included; migration script validates transaction wrappers and rollback presence. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes dependency-free checks with 8/8 tests. |
| Live PostgreSQL migration execution | Passed | Docker Desktop is available through the user-local Docker path; migrations executed successfully against PostgreSQL 18. |
| RLS acceptance harness | Passed | `npm run db:acceptance` applied migrations, bootstrapped `biznoryx_app`, and verified tenant read/write RLS behavior. |
| CI acceptance gate | Implemented | `.github/workflows/phase1.yml` runs `npm run verify` and `npm run db:acceptance` against PostgreSQL 18. |
| Database acceptance runbook | Implemented | `docs/runbooks/phase1-database-acceptance.md` documents the exact Phase 1 database proof before Phase 2. |

## Phase 1 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- migrations apply from a clean database
- runtime role `biznoryx_app` exists with `NOBYPASSRLS`
- tenant reads are scoped by `app.current_organization_id`
- default-deny behavior applies without tenant context
- same-tenant writes pass
- cross-tenant writes are blocked by RLS `WITH CHECK`

## Next Phase

Phase 2 may begin: Business onboarding.

## Phase 2 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Business profile model | Passed | `db/migrations/0003_phase2_business_onboarding.sql` creates structured business profiles with currency, fiscal year, timezone, status, versioning, and tenant ownership. |
| Business model structure | Passed | Product/service, location, customer segment, and channel records are supported through `business_model_entries`. |
| Business Understanding seed records | Passed | Confirmed/inferred facts, terms, goals, and KPI definitions are modeled as separate structured records. |
| Confirmed vs inferred separation | Passed | `BusinessOnboardingService.addFact` enforces fact kinds and prevents confirmed facts from carrying uncertain confidence values. |
| Server-side authorization | Passed | Onboarding mutations require `business.write`; summaries require `business.read`; tests cover viewer write denial and outsider access denial. |
| Completion gate | Passed | Onboarding cannot complete until required sections exist. |
| Audit logging | Passed | Profile, model entry, fact, term, goal, KPI, and completion events are recorded. |
| Loading/empty/incomplete/review/ready state contract | Passed | `businessOnboardingShellState` models onboarding UI states from authoritative summary data. |
| PostgreSQL RLS integration | Passed | Phase 2 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to onboarding tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 13/13 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1 and Phase 2 migrations and verifies onboarding RLS read/write behavior. |

## Phase 2 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1 and Phase 2 migrations apply from a clean database
- runtime role `biznoryx_app` has access to onboarding tables without bypassing RLS
- onboarding records are visible only within the active tenant context
- cross-tenant onboarding writes are blocked
- onboarding records default-deny without tenant context

## Next Phase

Phase 3 may begin: Data ingestion foundation.

## Phase 3 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Data source and stream model | Passed | `db/migrations/0004_phase3_data_ingestion_foundation.sql` creates tenant-owned data sources and recurring data streams. |
| Recurring reporting periods | Passed | `reporting_periods` ties each upload to a stream period so January, February, etc. extend one historical series. |
| Immutable raw data metadata | Passed | `raw_data_objects` stores generated storage keys, filenames, content type, byte size, checksum, status, and creator. |
| Schema baseline and versions | Passed | `stream_schema_versions` records profiled columns and schema fingerprints; first valid upload establishes the baseline. |
| Schema drift detection | Passed | `DataIngestionService.registerUpload` classifies drift as none, compatible, potentially compatible, or breaking; breaking drift rejects the run. |
| Upload security validation | Passed | Uploads validate extension, content type, size, row count, columns, and checksum content before acceptance. |
| Authorization | Passed | Ingestion writes require `business.write`; summaries require `business.read`; tests cover viewer and outsider mutation denial. |
| Lineage | Passed | `ingestion_runs` link data source, stream, reporting period, raw object, schema version, validation status, row count, and column count. |
| Validation evidence | Passed | `ingestion_validation_results` stores severity, code, and message for ingestion decisions. |
| Audit logging | Passed | Accepted and rejected ingestion runs emit audit events with schema drift metadata. |
| PostgreSQL RLS integration | Passed | Phase 3 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to ingestion tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 19/19 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1, 2, and 3 migrations and verifies ingestion RLS read/write behavior. |

## Phase 3 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1, 2, and 3 migrations apply from a clean database
- runtime role `biznoryx_app` has access to ingestion tables without bypassing RLS
- ingestion records are visible only within the active tenant context
- cross-tenant ingestion writes are blocked
- ingestion records default-deny without tenant context

## Next Phase

Phase 4 may begin: Semantic mapping and metric engine.

## Phase 4 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Semantic mapping model | Passed | `db/migrations/0005_phase4_semantic_mapping_metric_engine.sql` creates semantic mappings and mapping fields for stream schema versions. |
| Active mapping governance | Passed | Only active mappings can be used to create metric calculation specs; activating a mapping retires previous active mappings for the stream. |
| Metric calculation specs | Passed | Specs are tied to KPI definitions and semantic mappings with deterministic operations. |
| Deterministic metric engine | Passed | `SemanticMetricService.calculateMetric` supports sum, count, and average over mapped canonical rows. |
| No invented values | Passed | Invalid or non-numeric measure rows reject metric runs instead of creating values. |
| Verified metric lineage | Passed | `verified_metric_runs` link KPI definition, metric spec, ingestion run, reporting period, value, unit, and evidence. |
| Validation evidence | Passed | `metric_run_validation_results` stores metric calculation validation failures. |
| Authorization | Passed | Mapping, spec, and metric writes require `business.write`; tests cover viewer denial. |
| PostgreSQL RLS integration | Passed | Phase 4 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to semantic and metric tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 25/25 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-4 migrations and verifies semantic/metric RLS read/write behavior. |

## Phase 4 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1, 2, 3, and 4 migrations apply from a clean database
- runtime role `biznoryx_app` has access to semantic/metric tables without bypassing RLS
- semantic mappings and verified metric runs are visible only within the active tenant context
- cross-tenant semantic mapping writes are blocked
- verified metric runs default-deny without tenant context

## Next Phase

Phase 5 may begin: Baseline dashboard.

## Phase 5 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Dashboard snapshot model | Passed | `db/migrations/0006_phase5_baseline_dashboard.sql` creates tenant-owned dashboard snapshots and metric rows. |
| Verified metrics only | Passed | `BaselineDashboardService` builds KPI rows only from calculated `verifiedMetricRuns`. |
| Evidence links | Passed | Dashboard snapshots and KPI rows include verified metric, ingestion run, KPI, and reporting-period evidence. |
| Data health | Passed | Dashboard state reports validated/rejected ingestion runs, schema warnings, and risk text. |
| Empty and attention states | Passed | `dashboardShellState` exposes loading, empty, attention, and ready states. |
| Onboarding readiness | Passed | Dashboard generation rejects incomplete business onboarding. |
| Authorization | Passed | Dashboard generation and snapshot reads require `business.read`; tests cover viewer access and outsider denial. |
| Audit logging | Passed | Dashboard generation records `dashboard_snapshot.generated`. |
| PostgreSQL RLS integration | Passed | Phase 5 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to dashboard tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 30/30 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-5 migrations and verifies dashboard RLS read/write behavior. |

## Phase 5 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1, 2, 3, 4, and 5 migrations apply from a clean database
- runtime role `biznoryx_app` has access to dashboard tables without bypassing RLS
- dashboard snapshots and metric rows are visible only within the active tenant context
- cross-tenant dashboard writes are blocked
- dashboard snapshots default-deny without tenant context

## Next Phase

Phase 6 may begin: Historical comparison and trends.

## Phase 6 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Period comparison model | Passed | `db/migrations/0007_phase6_historical_comparison_trends.sql` creates tenant-owned metric period comparisons. |
| Trend summary model | Passed | `metric_trend_summaries` stores readiness, points, direction, summary, and evidence. |
| Deterministic calculations | Passed | `HistoricalTrendService` calculates absolute change, percent change, and direction from verified metric runs. |
| Readiness states | Passed | One verified period creates `not_ready` records with required/actual point evidence. |
| Zero previous value handling | Passed | Percent change is null when the previous metric value is zero. |
| Dashboard integration | Passed | Baseline dashboard trend rows use calculated comparison records when available. |
| Authorization | Passed | Trend calculation requires `business.write`; trend reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Comparison and trend calculations record audit events. |
| PostgreSQL RLS integration | Passed | Phase 6 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to trend tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 36/36 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-6 migrations and verifies trend RLS read/write behavior. |

## Phase 6 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-6 migrations apply from a clean database
- runtime role `biznoryx_app` has access to trend tables without bypassing RLS
- comparison and trend records are visible only within the active tenant context
- cross-tenant comparison writes are blocked
- comparison records default-deny without tenant context

## Next Phase

Phase 7 may begin: Change drivers, risks, and opportunities.

## Phase 7 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Performance finding model | Passed | `db/migrations/0008_phase7_change_drivers_risks_opportunities.sql` creates tenant-owned `performance_findings`. |
| Finding evidence model | Passed | `finding_evidence` links each finding to source evidence such as metric period comparisons. |
| Verified comparison dependency | Passed | `PerformanceFindingService.generateFindingsForComparison` rejects not-ready comparisons and only generates from calculated records. |
| Finding classification | Passed | Findings distinguish statistical signals, risks, opportunities, and recommendations. |
| No false causation | Passed | Generated explanations state metric movement as evidence and recommendations treat drivers as hypotheses until supported. |
| Severity classification | Passed | Severity is deterministic from percent-change magnitude, with null percent change handled explicitly. |
| Dashboard integration | Passed | Baseline dashboard surfaces open findings as risks, opportunities, and focus-area modules. |
| Authorization | Passed | Finding generation requires `business.write`; finding reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Finding creation records kind-specific audit events. |
| PostgreSQL RLS integration | Passed | Phase 7 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to finding tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 42/42 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-7 migrations and verifies finding RLS read/write behavior. |

## Phase 7 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-7 migrations apply from a clean database
- runtime role `biznoryx_app` has access to finding tables without bypassing RLS
- performance findings and evidence records are visible only within the active tenant context
- cross-tenant finding writes are blocked
- finding records default-deny without tenant context

## Next Phase

Phase 8 may begin: Actions and outcomes.

## Phase 8 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Management action model | Passed | `db/migrations/0009_phase8_actions_outcomes.sql` creates tenant-owned `management_actions`. |
| Action outcome model | Passed | `action_outcomes` links outcomes to actions, optional reporting periods, and verified metric runs. |
| Finding-to-action workflow | Passed | `ActionOutcomeService.createAction` requires a tenant-owned finding and accepts the finding when an action is created. |
| Ownership and assignment | Passed | Actions require an active organization member as owner. |
| Status lifecycle | Passed | Actions support planned, in-progress, completed, and cancelled states; cancelled actions cannot be reopened. |
| Outcome readiness | Passed | Outcomes require an in-progress or completed action before measurement can be recorded. |
| Outcome measurement | Passed | Baseline, outcome, and deterministic delta values are stored when provided. |
| Evidence preservation | Passed | Outcomes reference verified metric runs and reporting periods without rewriting source metric or finding evidence. |
| Dashboard integration | Passed | Baseline dashboard surfaces active actions and recorded outcomes as modules. |
| Authorization | Passed | Action/outcome writes require `business.write`; reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Action creation, status changes, and outcome records emit audit events. |
| PostgreSQL RLS integration | Passed | Phase 8 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to action/outcome tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 47/47 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-8 migrations and verifies action/outcome RLS read/write behavior. |

## Phase 8 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-8 migrations apply from a clean database
- runtime role `biznoryx_app` has access to action/outcome tables without bypassing RLS
- management actions and action outcomes are visible only within the active tenant context
- cross-tenant action writes are blocked
- action records default-deny without tenant context

## Next Phase

Phase 9 may begin: Professional reports.

## Phase 9 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Professional report model | Passed | `db/migrations/0010_phase9_professional_reports.sql` creates tenant-owned `professional_reports`. |
| Report section model | Passed | `professional_report_sections` stores ordered report sections with section kind and evidence payloads. |
| Evidence-linked report generation | Passed | `ProfessionalReportService.generateReport` composes verified metrics, trends, findings, actions, and outcomes into report sections. |
| Onboarding readiness | Passed | Report generation requires a completed business profile and tenant-owned reporting period when supplied. |
| Report state contract | Passed | `reportShellState` exposes loading, empty, attention, and ready report states. |
| Dashboard integration | Passed | Baseline dashboard surfaces generated professional reports and adds the Reports module. |
| Authorization | Passed | Report generation requires `business.write`; report reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Report generation records `professional_report.generated` with section count metadata. |
| PostgreSQL RLS integration | Passed | Phase 9 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to report tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 52/52 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-9 migrations and verifies report RLS read/write behavior. |

## Phase 9 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-9 migrations apply from a clean database
- runtime role `biznoryx_app` has access to report tables without bypassing RLS
- professional reports and report sections are visible only within the active tenant context
- cross-tenant report writes are blocked
- report records default-deny without tenant context

## Next Phase

Phase 10 may begin: Live integrations and synchronization.

## Phase 10 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Integration connection model | Passed | `db/migrations/0011_phase10_live_integrations_sync.sql` creates tenant-owned `integration_connections`. |
| Sync run model | Passed | `integration_sync_runs` stores idempotent sync attempts, status, record counts, errors, and evidence. |
| Webhook event model | Passed | `integration_webhook_events` stores provider event IDs, idempotency keys, payload fingerprints, status, and evidence. |
| Secret safety | Passed | `IntegrationSyncService.createConnection` rejects raw secrets in config and stores only `secretRef`. |
| No invented provider APIs | Passed | Phase 10 implements the synchronization control plane only; provider-specific API calls are deferred until official docs and credentials exist. |
| Idempotency | Passed | Sync runs and webhook events deduplicate repeated idempotency keys/provider event IDs. |
| Status lifecycle | Passed | Connections, sync runs, and webhook events use explicit statuses with validation. |
| Dashboard integration | Passed | Baseline dashboard surfaces integration freshness and adds the Integrations module. |
| Authorization | Passed | Integration mutations require `business.write`; reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Connection creation, connection status changes, sync lifecycle events, and webhook events emit audit records. |
| PostgreSQL RLS integration | Passed | Phase 10 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to integration tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 59/59 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-10 migrations and verifies integration RLS read/write behavior. |

## Phase 10 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-10 migrations apply from a clean database
- runtime role `biznoryx_app` has access to integration tables without bypassing RLS
- integration connections, sync runs, and webhook events are visible only within the active tenant context
- cross-tenant integration writes are blocked
- integration records default-deny without tenant context

## Next Phase

Phase 11 may begin: Alerts and monitoring.

## Phase 11 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Alert rule model | Passed | `db/migrations/0012_phase11_alerts_monitoring.sql` creates tenant-owned `alert_rules`. |
| Alert event model | Passed | `alert_events` stores alert status, severity, source, fingerprint, evidence, acknowledgment, and resolution state. |
| Notification model | Passed | `alert_notifications` tracks intended notification channel, recipient, status, errors, and send time. |
| Deterministic monitoring | Passed | `AlertMonitoringService.evaluateRules` evaluates sync failures, data health attention, and high-severity findings from stored records. |
| Alert deduplication | Passed | Open and acknowledged alerts are deduplicated by rule and fingerprint. |
| Notification lifecycle | Passed | Notifications support pending, sent, failed, and suppressed states with audit events. |
| Dashboard integration | Passed | Baseline dashboard surfaces unresolved alerts and adds the Alerts module. |
| Authorization | Passed | Alert mutations require `business.write`; reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Rule creation, alert opening, acknowledgment, resolution, and notification state changes emit audit records. |
| PostgreSQL RLS integration | Passed | Phase 11 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to alert tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 64/64 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-11 migrations and verifies alert RLS read/write behavior. |

## Phase 11 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-11 migrations apply from a clean database
- runtime role `biznoryx_app` has access to alert tables without bypassing RLS
- alert rules, alert events, and alert notifications are visible only within the active tenant context
- cross-tenant alert writes are blocked
- alert records default-deny without tenant context

## Next Phase

Phase 12 may begin: Forecasts and scenarios.

## Phase 12 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Forecast model | Passed | `db/migrations/0013_phase12_forecasts_scenarios.sql` creates tenant-owned forecast models linked to KPI definitions with model kind, minimum history, horizon, status, and audit columns. |
| Scenario model | Passed | Forecast scenarios store assumptions, active/draft/archive state, and numeric adjustment percentages without inventing external drivers. |
| Forecast run model | Passed | Forecast runs store status, horizon, points used, baseline, slope, forecast values, uncertainty, readiness, and evidence. |
| Deterministic forecast calculation | Passed | `ForecastScenarioService.runForecast` calculates a linear projection from verified metric history only. |
| Readiness states | Passed | Insufficient verified history records a `not_ready` run with required and actual point counts instead of producing fake projections. |
| Scenario controls | Passed | Runs require active forecast models and active scenarios; invalid numeric adjustments are rejected. |
| Dashboard integration | Passed | Baseline dashboard surfaces forecast rows and adds the Forecasts module when runs exist. |
| Authorization | Passed | Forecast mutations require `business.write`; forecast reads require `business.read`; tests cover viewer and outsider behavior. |
| Audit logging | Passed | Model creation, scenario creation, calculated runs, and not-ready runs emit audit events. |
| PostgreSQL RLS integration | Passed | Phase 12 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to forecast tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 70/70 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-12 migrations and verifies forecast RLS read/write behavior. |

## Phase 12 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-12 migrations apply from a clean database
- runtime role `biznoryx_app` has access to forecast tables without bypassing RLS
- forecast models, scenarios, and runs are visible only within the active tenant context
- cross-tenant forecast writes are blocked
- forecast records default-deny without tenant context

## Next Phase

Phase 13 may begin: Enterprise scaling.

## Phase 13 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Organization plan model | Passed | `db/migrations/0014_phase13_enterprise_scaling.sql` creates tenant-owned organization plans with status and structured limits. |
| Usage windows and quotas | Passed | `organization_usage_windows` stores monthly usage totals and `EnterpriseScalingService.recordUsage` enforces plan limits. |
| Rate-limit evidence | Passed | `rate_limit_events` records allowed and blocked decisions with operation keys, quantities, limits, and actor context. |
| Worker job leasing | Passed | `worker_jobs` supports idempotent queueing, leasing, completion, attempts, lease expiry, and errors. |
| Concurrency controls | Passed | Job leasing respects per-organization `maxConcurrentJobs` before assigning more work. |
| Operational health | Passed | `enterpriseHealth` summarizes plan, usage windows, blocked events, queued jobs, active leases, and failed jobs. |
| Dashboard integration | Passed | Baseline dashboard surfaces enterprise scaling state and adds the Enterprise Scaling module when scaling records exist. |
| Authorization | Passed | Plan management requires `organization.manage`; scaling mutations require `business.write`; health reads require `business.read`; tests cover viewer, analyst, admin, owner, and outsider behavior. |
| Audit logging | Passed | Plan changes, usage records, quota blocks, job queueing, leasing, and completion emit audit events. |
| PostgreSQL RLS integration | Passed | Phase 13 tables have RLS policies with explicit `WITH CHECK`. |
| Runtime database role | Passed | `biznoryx_app` receives least-privilege access to enterprise scaling tables and remains `NOBYPASSRLS`. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 75/75 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-13 migrations and verifies enterprise scaling RLS read/write behavior. |

## Phase 13 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
```

The database acceptance run used PostgreSQL 18 via Docker Compose and proved:

- Phase 1-13 migrations apply from a clean database
- runtime role `biznoryx_app` has access to enterprise scaling tables without bypassing RLS
- organization plans, usage windows, rate-limit events, and worker jobs are visible only within the active tenant context
- cross-tenant worker job writes are blocked
- enterprise scaling records default-deny without tenant context

## Next Phase

All planned Phase 1-13 product foundation slices are accepted. Any next work should be a new explicitly scoped roadmap item.

## Phase 14 - Release Readiness and Production Hardening

Status: **accepted**

This acceptance covers repository-level release validation and tests only. Public production remains blocked until real provider settings, database acceptance, deployment, and accountable approvals are verified.

## Phase 14 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Production environment validation | Passed | `src/release/readiness.mjs` validates required production variables, PostgreSQL URL shape, non-local database credentials, HTTPS public URL, secret lengths, storage settings, and managed secret provider. |
| Release gate script | Passed | `scripts/release-check.mjs` evaluates production readiness and fails loudly with blockers. |
| Release evidence contract | Passed | Readiness evaluation requires accepted Phase 13 status, release script presence, Phase 13 migration/rollback, and Phase 13 database acceptance script. |
| Unsafe local deploy prevention | Passed | Tests prove local database URLs, development passwords, short secrets, HTTP URLs, and unsupported secret providers block release readiness. |
| Runbook | Passed | `docs/runbooks/phase14-release-readiness.md` documents required release gates and production settings. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 79/79 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-13 migrations and verifies all RLS acceptance gates. |
| Release check behavior | Passed | `npm run release:check` is intentionally environment-sensitive; tests verify both blocked and ready outcomes with deterministic environment data. |

## Phase 14 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
node --test tests/phase14-release-readiness.test.mjs
```

`npm run release:check` is expected to fail in this local workspace unless real production environment variables are supplied. The deterministic Phase 14 tests verify the same release gate with both unsafe local values and safe production-shaped values.

## Remaining Production Readiness Phases

Two phases remain before a real public production launch:

- Phase 15: production deployment and operations
- Phase 16: enterprise security/compliance polish

## Phase 15 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Deployment manifest | Passed | `deploy/production.manifest.json` defines provider-neutral production services, replicas, health check, resources, backups, managed secrets, release strategy, preflight gates, and rollback runbook. |
| Manifest validation | Passed | `src/ops/deployment.mjs` blocks unsafe deployment shapes such as single web/worker replicas, public database access, missing backups, public object storage, unmanaged secrets, missing preflight gates, and disabled rollback. |
| Deployment health gate | Passed | `deploymentHealth` requires manifest readiness, release readiness, and database acceptance before deployment can proceed. |
| Deploy check script | Passed | `scripts/deploy-check.mjs` fails unless release readiness and database acceptance readiness flags are set. |
| Operations runbook | Passed | `docs/runbooks/phase15-production-operations.md` documents preflight, runtime shape, deployment steps, and rollback. |
| ADR | Passed | `docs/adr/0015-phase15-production-deployment-operations.md` records the cloud-neutral deployment decision. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 83/83 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-13 migrations and verifies all RLS acceptance gates. |
| Deployment check behavior | Passed | `npm run deploy:check` blocks without readiness flags and passes with release/database readiness flags set. |

## Phase 15 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
node --test tests/phase15-production-operations.test.mjs
npm run deploy:check
```

`npm run deploy:check` is expected to fail unless successful release-readiness and database-acceptance gates have set readiness flags. The deterministic Phase 15 tests verify ready, blocked, and operator-review paths.

## Remaining Production Readiness Phases

One phase remains before a real public production launch:

- Phase 16: enterprise security/compliance polish

## Phase 16 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Security controls manifest | Passed | `compliance/security-controls.manifest.json` maps required security controls to evidence paths and owners. |
| Compliance validation | Passed | `src/compliance/controls.mjs` validates required controls, implemented status, evidence, owners, data protection classes, encryption, retention, incident runbook, and audit evidence review requirement. |
| Compliance gate script | Passed | `scripts/compliance-check.mjs` blocks unless release readiness, deployment readiness, and accountable evidence review are explicitly marked ready. |
| Data protection checks | Passed | Required classes cover business data, account data, audit data, and raw uploads with retention and encryption requirements. |
| Security incident runbook | Passed | `docs/runbooks/phase16-security-compliance.md` documents evidence review, incident response, and compliance boundary. |
| ADR | Passed | `docs/adr/0016-phase16-enterprise-security-compliance.md` records the compliance-readiness decision and non-certification boundary. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 87/87 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-13 migrations and verifies all RLS acceptance gates. |
| Compliance check behavior | Passed | `npm run compliance:check` blocks without readiness/evidence flags and passes with release/deployment/evidence flags set. |

## Phase 16 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
node --test tests/phase16-security-compliance.test.mjs
npm run compliance:check
```

`npm run compliance:check` is expected to fail unless release readiness, deployment readiness, and accountable evidence review flags are set. The deterministic Phase 16 tests verify ready and blocked paths.

## Production Readiness Result

All planned production readiness phases are accepted:

- Phase 1-13: product foundation
- Phase 14: release readiness and production hardening
- Phase 15: production deployment and operations
- Phase 16: enterprise security and compliance polish

BIZNORYX has a production-readiness foundation in this repository. A real public launch still requires real production infrastructure, real production secrets, provider-specific deployment, and any external compliance audit the business chooses to pursue.

## Phase 17 Acceptance Gates

| Gate | Status | Evidence |
|---|---|---|
| Launch handoff manifest | Passed | `launch/beta-handoff.manifest.json` defines private beta stage, launch owner, handoff items, beta scope, excluded data, required gates, and final approval requirement. |
| Launch validation | Passed | `src/launch/handoff.mjs` validates required handoff items, owners, evidence, beta customer limits, excluded data, release/deployment/compliance gates, and final approval. |
| Launch check script | Passed | `scripts/launch-check.mjs` blocks unless release readiness, deployment readiness, compliance readiness, and final approval are explicitly marked ready. |
| Customer beta limits | Passed | Default launch manifest limits beta to friendly design partners/internal pilots and excludes regulated health data, payment card numbers, and government identifiers. |
| Launch runbook | Passed | `docs/runbooks/phase17-launch-handoff.md` documents required gates, customer handoff, go/no-go, and known limitations. |
| ADR | Passed | `docs/adr/0017-phase17-launch-handoff-beta-operations.md` records the beta launch handoff decision and launch boundary. |
| Format/lint/typecheck/tests/build/security checks | Passed | `npm run verify` passes with 91/91 tests. |
| Live PostgreSQL acceptance | Passed | `npm run db:acceptance` applies Phase 1-13 migrations and verifies all RLS acceptance gates. |
| Launch check behavior | Passed | `npm run launch:check` blocks without readiness/approval flags and passes with release/deployment/compliance/approval flags set. |

## Phase 17 Verification

Passed on this workspace:

```text
npm run verify
npm run db:acceptance
node --test tests/phase17-launch-handoff.test.mjs
npm run launch:check
```

`npm run launch:check` is expected to fail unless release readiness, deployment readiness, compliance readiness, and final accountable approval flags are set. The deterministic Phase 17 tests verify ready and blocked paths.

## Launch Readiness Result

All planned production-readiness and launch-handoff phases are accepted through Phase 17.

BIZNORYX is ready in this repository for controlled beta handoff under the documented constraints. A real public launch still requires real production infrastructure, real secrets, provider-specific deployment, customer contracts, and any external compliance audit the business chooses to pursue.

## Review Application Surface

Current phase: **Review-ready application layer**

Status: **accepted for local review**

| Gate | Status | Evidence |
|---|---|---|
| Authenticated browser app | Passed | `scripts/app-server.mjs`, `src/webapp/review-app.mjs`, and `web-app/*` provide a protected review app at `http://127.0.0.1:4174`. |
| Server-side sessions and cookies | Passed | Review app signs in through `SessionService`, sets the existing secure session cookie contract, and protects dashboard/API routes. |
| Email verification | Passed for local review | Registration issues a one-time email verification code through `EmailVerificationService`; the browser journey verifies the code before entering the workspace. Production still requires managed email delivery. |
| CSRF-protected mutations | Passed | Organization switching, sign-out, onboarding saves, invitation creation, and ingestion registration require the session CSRF token. |
| Organization switching and IDOR/BOLA protection | Passed | `tests/review-app.test.mjs` proves outsider organization switching attempts are denied. |
| Onboarding and ingestion intake | Passed | The review app exposes customer profile and upload-registration flows backed by server-side authorization and audit logging. |
| Tenant audit evidence | Passed | Mutations write tenant-scoped audit events and the dashboard renders recent tenant audit activity. |
| Loading, error, empty, and disabled-ready UI path | Passed | Browser app includes signed-out, loading, protected workspace, mutation feedback, validation failure, protected-route redirect, network retry, and disabled confirm surfaces. |
| Real customer journey | Passed for local review | Desktop and mobile browser tests cover landing, email-code registration, business creation, file upload, validation, confirmation, dashboard reload, invalid upload rejection, sign-out, and protected route redirect. |
| Billing surface | Passed for local review | The workspace exposes a `$20/month` subscription state and Paystack-ready checkout API, with local review completion for non-production testing. |
| Paystack webhook boundary | Passed for local review | `/api/billing/paystack/webhook` validates the `x-paystack-signature` HMAC-SHA512 header over the raw body before applying charge, invoice and subscription events. Duplicate events are idempotent. |
| Dashboard figures | Passed for local review | Primary metric totals and reporting history are calculated from confirmed uploaded CSV rows and rendered as a line chart. Empty dashboards remain empty instead of showing fake KPI values. |
| Tenant switching | Passed for local review | Browser tests prove uploads, validation review, dashboard metrics, and activity do not leak between seeded organizations. |
| Verification | Passed | `npm run verify` passes with 112/113 Node tests and one intentionally skipped live-DB test; `npm run test:browser` passes with 21/21 desktop and mobile browser tests; `npm run db:runtime` passes; `npm run db:acceptance` passes against a clean disposable PostgreSQL database; `npm audit --omit=dev` reports 0 production dependency vulnerabilities. |

## Customer Evidence Reporting Surface

Status: **accepted for local review**

| Gate | Status | Evidence |
|---|---|---|
| Public product story | Passed | Header routes for Product, Solutions, Pricing, Security, and Resources render complete pages, and the landing page explains business memory, generic data intake, evidence reports, subscription pricing, and recurring decision cadence. |
| Generic CSV intake | Passed | Upload validation accepts up to 10 CSV files per batch, named business data series, and optional metric columns instead of only sales/revenue files. |
| Recurring-series safety | Passed | Confirming a later period requires the same schema and metric mapping within the same named series, while different datasets can be represented as separate series. |
| Evidence report generation | Passed | Confirmed uploads generate verified facts, period-comparison facts, contribution facts, and source evidence from uploaded rows, checksums, columns, and deterministic calculations. Recommendation language is not presented as evidence. |
| Dashboard integration | Passed | The dashboard shows active data series, primary metric, data health, latest source evidence, and report counts without fabricated values. |
| Workspace report page | Passed | Evidence Reports renders verified facts, period-comparison facts, contribution facts, and source strips for each confirmed upload. |
| Tests | Passed | `tests/customer-journey.test.mjs` covers email verification, local review billing, signed Paystack webhooks, multi-file uploads, generic transaction evidence reports and recurring evidence summaries; `tests/browser/customer.spec.mjs` verifies the report page; `tests/browser/navigation.spec.mjs` verifies public header routes, billing, tenant isolation and workspace navigation. |

## Public Production Boundary

The repository now has a local review app and accepted production kernel, but it is not yet a real public production launch. Public production still requires a selected live hosting account, production PostgreSQL and private object storage, managed runtime secrets, custom domain DNS, managed email delivery, Paystack production keys/plan/webhook verification, customer terms, and any external compliance audit or certification the business requires.
