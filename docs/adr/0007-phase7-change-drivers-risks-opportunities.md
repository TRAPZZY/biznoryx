# ADR 0007: Phase 7 Change Drivers, Risks, and Opportunities

## Status

Accepted

## Context

BIZNORYX must explain meaningful movement in verified business metrics without inventing causes or presenting hypotheses as facts.

Phase 7 builds on verified period comparisons from Phase 6. It creates structured findings for statistical signals, risks, opportunities, and recommendations, each tied back to metric comparison evidence.

## Decision

Phase 7 introduces:

- performance findings
- finding evidence records
- severity classification from verified percent change magnitude
- dashboard integration for risks, opportunities, and focus areas
- audit events for each created finding

The implementation deliberately separates:

- `statistical_signal`: verified metric movement
- `risk`: evidence-backed downside attention area
- `opportunity`: evidence-backed upside attention area
- `recommendation`: next investigative action

Findings require a calculated comparison. Insufficient-history and not-ready comparisons cannot produce findings. Recommendation text treats drivers as hypotheses until further evidence is attached.

All finding generation requires `business.write`. Finding reads require `business.read`. Finding tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 8 can attach management actions and outcomes to findings. That next phase should close the loop from signal to decision to measurable later result without changing historical metric evidence.
