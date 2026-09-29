# ADR 0004: Phase 4 Semantic Mapping and Metric Engine

## Status

Accepted

## Context

BIZNORYX must never invent KPI values. Metrics must be calculated deterministically from verified ingestion runs through governed semantic mappings.

Phase 4 connects ingested stream schemas to canonical business fields and creates auditable metric calculation specs and verified metric run records.

## Decision

Phase 4 introduces:

- semantic mappings for stream schema versions
- semantic mapping fields from source columns to canonical fields
- metric calculation specs tied to KPI definitions and active mappings
- verified metric runs tied to ingestion runs and reporting periods
- metric validation evidence

Only active semantic mappings may be used for metric specs. Metric calculations are deterministic and currently support `sum`, `count`, and `average`. Invalid rows reject the metric run instead of producing invented values.

All writes require `business.write`. All tables are tenant-owned, protected by RLS with `WITH CHECK`, and covered by live PostgreSQL acceptance.

## Consequences

Phase 5 can build a baseline dashboard using verified metric runs rather than fake charts or inferred values. Dashboard components must show only calculated values with evidence and data-health state.
