# ADR 0005: Phase 5 Baseline Dashboard

## Status

Accepted

## Context

BIZNORYX needs a serious executive dashboard that displays verified business performance, data health, and evidence. It must not use fake charts or decorative analytics.

After Phases 1-4, the platform has tenant identity, business onboarding, recurring ingestion, semantic mappings, and verified metric runs. Phase 5 composes those records into a baseline dashboard state.

## Decision

Phase 5 introduces dashboard snapshots and dashboard snapshot metric rows.

Dashboard generation:

- requires completed business onboarding
- reads only calculated verified metric runs
- links every displayed KPI to evidence
- reports ingestion data health and risks
- emits empty and attention states instead of pretending data exists
- records an audit event

Dashboard reads require `business.read`. Snapshot tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 6 can build historical comparison and trends on top of verified metric runs and dashboard snapshots. Any visual dashboard UI must consume this state contract and must not invent values or modules.
