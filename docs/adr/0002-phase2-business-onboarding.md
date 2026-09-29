# ADR 0002: Phase 2 Business Onboarding

## Status

Accepted

## Context

After identity, organizations, authorization, and tenant isolation are accepted, BIZNORYX needs a real onboarding vertical slice that captures the business model before ingestion begins.

The onboarding model must not be a generic profile blob. It has to create structured, tenant-owned records that later feed the Business Understanding Engine, KPI definitions, ingestion mapping, dashboard relevance, and analysis readiness.

## Decision

Phase 2 introduces structured onboarding records:

- business profiles
- product/service, location, customer segment, and channel entries
- confirmed and inferred business facts
- business terminology
- goals
- KPI definitions

The implementation keeps confirmed facts separate from inferred facts, requires provenance/source fields, versions KPI definitions, and requires a minimum business model before onboarding can be completed.

All onboarding mutations require `business.write`. Read summaries require `business.read`. All tables are tenant-owned, covered by PostgreSQL RLS, and tested through the live database acceptance gate.

## Consequences

Phase 3 ingestion can rely on a real organization profile and initial semantic business context. It must map incoming data to these structured records instead of creating unrelated one-off analyses.
