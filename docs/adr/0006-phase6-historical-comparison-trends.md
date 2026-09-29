# ADR 0006: Phase 6 Historical Comparison and Trends

## Status

Accepted

## Context

BIZNORYX must compare recurring verified metric values across reporting periods without pretending that insufficient history supports long-term trends, seasonality, or forecasts.

Phase 6 builds deterministic period comparison and trend summary records on top of verified metric runs.

## Decision

Phase 6 introduces:

- metric period comparisons
- metric trend summaries
- readiness states for insufficient history
- deterministic absolute change, percent change, and direction
- dashboard trend integration

The implementation calculates only what the evidence supports. One period produces a `not_ready` comparison. Two or more periods can produce period comparisons and a basic trend direction. Percent change is null when the previous value is zero.

All calculations require `business.write`. Trend reads require `business.read`. Trend tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 7 can build change drivers, risks, and opportunities on top of verified trend/comparison records. It must continue to distinguish deterministic facts from hypotheses and recommendations.
