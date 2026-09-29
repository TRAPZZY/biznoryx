# ADR 0009: Phase 9 Professional Reports

## Status

Accepted

## Context

BIZNORYX needs reports that executives can use outside the dashboard while preserving the evidence chain behind every claim. Reports must not invent analytics, causes, or recommendations; they should package verified metrics, trends, findings, actions, and outcomes into a durable artifact.

Phase 9 builds on the accepted evidence chain from Phases 4 through 8.

## Decision

Phase 9 introduces:

- professional report records
- ordered report sections
- report status and generation metadata
- evidence payloads per section
- a report shell state contract
- dashboard awareness of generated reports

Generated reports always include:

- executive summary
- KPI scorecard
- historical trends
- findings
- management actions
- measured outcomes
- data health
- evidence appendix

Report generation requires completed onboarding and `business.write`. Reading reports requires `business.read`. Report tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 10 can build live integrations and synchronization while reports remain an auditable output layer over already verified records.
