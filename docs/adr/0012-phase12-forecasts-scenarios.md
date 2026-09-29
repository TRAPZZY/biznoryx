# ADR 0012: Phase 12 Forecasts and Scenarios

## Status

Accepted

## Context

BIZNORYX needs forward-looking planning without crossing the product boundary into invented analytics. Forecasts must be derived from verified historical metric records, clearly expose readiness and uncertainty, and stay tenant-scoped like the rest of the business memory.

## Decision

Phase 12 introduces:

- forecast models tied to KPI definitions
- forecast scenarios with named assumptions and numeric adjustment percentages
- forecast runs with calculated or not-ready status
- deterministic linear projection from verified metric runs
- readiness metadata for insufficient history
- uncertainty metadata and evidence links
- dashboard visibility for forecast runs

Forecasting mutations require `business.write`. Reads require `business.read`. Forecast tables are tenant-owned and protected by RLS with `WITH CHECK`.

The first supported model kind is `linear_projection`. More sophisticated forecasting can be added later only when the verified data depth, model governance, validation metrics, and explainability are ready.

## Consequences

Phase 13 can focus on enterprise scaling while forecasts remain conservative, auditable, and clearly separated from recommendations or causal claims.
