# BIZNORYX Production

BIZNORYX is a Business Performance Memory & Intelligence Platform.

This repository currently contains the production kernel and Phase 1 vertical slice:

- tenant-aware PostgreSQL schema and Row-Level Security migrations
- real session primitives with secure cookie attributes and CSRF validation
- organizations, memberships, invitation lifecycle, organization switching
- capability-based authorization
- organization-aware transaction contract for RLS
- audit logging model
- protected application shell contract
- tests for IDOR/BOLA, disabled member revocation, invitations, and capability enforcement

It also contains the accepted Phase 2 business onboarding slice:

- structured business profiles
- product/service, location, customer segment, and channel records
- confirmed and inferred business facts
- business terminology
- goals and KPI definitions
- onboarding completion gates
- tenant-scoped RLS acceptance for onboarding records

It also contains the accepted Phase 3 data ingestion foundation:

- tenant-owned data sources and recurring streams
- reporting periods for recurring historical series
- immutable raw data object metadata
- schema versions and schema drift classification
- ingestion runs and validation evidence
- tenant-scoped RLS acceptance for ingestion records

It also contains the accepted Phase 4 semantic mapping and metric engine:

- semantic mappings from source columns to canonical fields
- active mapping governance
- metric calculation specs tied to KPI definitions
- deterministic sum/count/average metric runs
- metric validation evidence
- tenant-scoped RLS acceptance for semantic and metric records

It also contains the accepted Phase 5 baseline dashboard:

- dashboard snapshots
- verified KPI scoreboard rows
- business pulse and module state contract
- data health and risk state
- evidence-linked dashboard metrics
- tenant-scoped RLS acceptance for dashboard records

It also contains the accepted Phase 6 historical comparison and trends layer:

- verified metric period comparisons
- basic trend summaries
- insufficient-history readiness states
- deterministic absolute and percent change calculations
- dashboard trend integration
- tenant-scoped RLS acceptance for trend records

It also contains the accepted Phase 7 change drivers, risks, and opportunities layer:

- evidence-backed performance findings
- finding evidence records linked to verified metric comparisons
- statistical signal, risk, opportunity, and recommendation classifications
- deterministic severity from verified percent-change magnitude
- dashboard risk, opportunity, and focus-area integration
- tenant-scoped RLS acceptance for finding records

It also contains the accepted Phase 8 actions and outcomes layer:

- management actions linked to performance findings
- action ownership, due dates, status lifecycle, and success metrics
- measured outcomes linked to actions and optional verified metric evidence
- deterministic baseline-to-outcome deltas
- dashboard action and outcome integration
- tenant-scoped RLS acceptance for action and outcome records

It also contains the accepted Phase 9 professional reports layer:

- durable professional report records
- ordered report sections
- evidence-linked executive summary, KPI, trend, finding, action, outcome, data health, and appendix sections
- report shell states
- dashboard report integration
- tenant-scoped RLS acceptance for report records

It also contains the accepted Phase 10 live integrations and synchronization layer:

- integration connection records
- sync run lifecycle and idempotency
- webhook event recording and payload fingerprints
- secret references instead of raw credentials
- dashboard integration freshness
- tenant-scoped RLS acceptance for integration records

It also contains the accepted Phase 11 alerts and monitoring layer:

- alert rules over stored business and operational records
- alert events with evidence, fingerprints, acknowledgment, and resolution
- notification lifecycle tracking
- monitoring for sync failures, data health attention, and high-severity findings
- dashboard alert visibility
- tenant-scoped RLS acceptance for alert records

It also contains the accepted Phase 12 forecasts and scenarios layer:

- forecast models linked to KPI definitions
- scenario assumptions and adjustment percentages
- deterministic linear projections from verified metric history
- readiness handling when history is insufficient
- forecast uncertainty and evidence records
- dashboard forecast visibility
- tenant-scoped RLS acceptance for forecast records

It also contains the accepted Phase 13 enterprise scaling layer:

- organization plan limits
- monthly usage windows and quota decisions
- rate-limit evidence records
- idempotent worker job queueing and leases
- per-organization concurrency control
- operational health summaries
- dashboard enterprise scaling visibility
- tenant-scoped RLS acceptance for scaling records

It also contains the accepted Phase 14 release readiness layer:

- production environment validation
- release readiness gate script
- local-development configuration blockers
- managed secret/storage/deployment configuration checks
- release runbook for final production gates

It also contains the accepted Phase 15 production deployment and operations layer:

- provider-neutral production deployment manifest
- deployment manifest validation
- deployment health gate
- deploy check script
- production operations and rollback runbook

It also contains the accepted Phase 16 enterprise security and compliance layer:

- security controls manifest
- compliance evidence validation
- data protection class checks
- compliance gate script
- security incident and compliance runbook

It also contains the accepted Phase 17 launch handoff and beta operations layer:

- private beta launch handoff manifest
- launch go/no-go validation
- customer handoff scope limits
- launch check script
- beta operations runbook

It also contains the durable billing persistence foundation:

- PostgreSQL schema for organization subscriptions, checkout sessions, and Paystack webhook events
- RLS policies and runtime-role grants for billing records
- rollback migration and SQL acceptance coverage
- a PostgreSQL billing repository seam for subscription creation, checkout recording, webhook event persistence, and duplicate event handling

The original `/mnt/data/biznoryx-production` checkout was not present in this Windows workspace, so the repository was reconstructed here from the product instructions and prior build status summary.

## Verification

Run:

```bash
npm run verify
```

PostgreSQL integration tests require a local PostgreSQL server. The acceptance runner uses host `psql` when available and falls back to Docker Compose `psql` inside the local PostgreSQL container.

When PostgreSQL tooling is available:

```bash
docker compose up -d postgres
$env:DATABASE_URL="postgresql://biznoryx_admin:biznoryx_local_password@localhost:5432/biznoryx"
npm run db:acceptance
```

The acceptance runner applies migrations, creates a least-privilege `biznoryx_app` role with `NOBYPASSRLS`, and runs the Phase 1-13 RLS checks. Set `BIZNORYX_APP_DB_PASSWORD` before using the bootstrap script outside local development.

For production release readiness, run `npm run release:check` with real production environment variables. Local development values are intentionally blocked.

For production deployment readiness, run `npm run deploy:check` after `verify`, database acceptance, and release readiness have passed. The check consumes `deploy/production.manifest.json`.

For final security and compliance readiness, run `npm run compliance:check` after release and deployment readiness are complete and compliance evidence has been reviewed.

For controlled beta launch readiness, run `npm run launch:check` after release, deployment, compliance readiness, and accountable final approval are complete.

To inspect the local product preview:

```bash
npm run preview
```

Then open `http://127.0.0.1:4173`. The preview is a browser-visible product surface over deterministic sample state; it is not a deployed production app.

To review the authenticated application surface:

```bash
npm run app
```

Then open `http://127.0.0.1:4174` and sign in with `owner@biznoryx.local` / `ReviewPassphrase2026!`, or create a new account from the landing page. This review app now covers the visible customer journey: longer photographic landing page with Product, Solutions, Pricing, Security, and Resources routes; one-time email-code registration; sign-in; business profile; multi-file generic CSV business-data upload; validation review; explicit import confirmation; named recurring data series; fact-only evidence reports with contribution facts; primary-metric line-chart dashboard; upload history; `$20/month` billing state with Paystack-ready checkout and signed webhook handling; tenant switching; and truthful tenant activity. Dashboard figures and evidence reports are calculated from confirmed uploaded CSV rows, not fabricated preview data. Billing now also has a durable PostgreSQL schema/repository foundation, although the visible review runtime still uses guarded in-memory state until the remaining HTTP repositories are connected.

This remains a local review environment. The in-memory runtime is intentionally blocked from `NODE_ENV=production` until durable PostgreSQL-backed repositories, private object storage, managed secrets, managed email/recovery flows, Paystack production keys/plan/webhook verification, provider deployment, custom domain DNS, customer terms, and any required external compliance audit are completed.

Useful local checks:

```bash
npm run verify
npm run db:runtime
npm run test:browser
npm audit --omit=dev
```

`npm run db:runtime` creates a uniquely named disposable PostgreSQL database in the local Docker service, applies every migration, bootstraps the restricted runtime role, proves durable identity/session/organization behavior and tenant isolation, and then removes only that disposable database.

The same database gate is wired into `.github/workflows/phase1.yml` for CI environments with PostgreSQL available.

See `docs/runbooks/phase1-database-acceptance.md` for the operator checklist.
