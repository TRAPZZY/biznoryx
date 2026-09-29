# ADR 0013: Phase 13 Enterprise Scaling

## Status

Accepted

## Context

BIZNORYX now has tenant-owned foundations for identity, business memory, ingestion, metrics, dashboards, trends, findings, actions, reports, integrations, alerts, and forecasts. Enterprise readiness requires operational controls before the product grows into heavier workloads: plan limits, quota evidence, job leasing, concurrency limits, and health visibility.

## Decision

Phase 13 introduces:

- organization plans with structured limits
- monthly usage windows
- rate-limit decision records
- idempotent worker jobs
- worker leases with expiry and attempts
- per-organization concurrency controls
- enterprise operational health summaries
- dashboard visibility for scaling state

Plan management requires `organization.manage`. Usage, quota, and worker mutations require `business.write`. Health reads require `business.read`. Enterprise scaling tables are tenant-owned and protected by RLS with `WITH CHECK`.

The worker job model is a durable control plane, not a full external queue implementation. Provider-specific queue backends, distributed locks, and autoscaling policies can be attached later without changing the tenant and audit contract.

## Consequences

The Phase 1-13 product foundation is complete enough to support the next roadmap as explicitly scoped product or infrastructure work instead of continuing to add broad foundational phases.
