# ADR 0008: Phase 8 Actions and Outcomes

## Status

Accepted

## Context

BIZNORYX must close the loop between a detected business signal and a later management result. A finding is not enough; teams need to assign actions, track their state, and attach measured outcomes without changing the original metric evidence.

Phase 8 builds on Phase 7 findings and Phase 4 verified metric runs.

## Decision

Phase 8 introduces:

- management actions linked to performance findings
- owner, due date, status, and success metric fields
- action outcomes linked to actions and optional verified metric evidence
- deterministic outcome deltas when baseline and outcome values are provided
- dashboard integration for action and outcome modules
- audit events for action creation, status changes, and outcome recording

Actions accept a finding when they are created from it, but they do not rewrite the finding evidence. Outcomes require an action to be in progress or completed. Outcome assessments are explicit: improved, declined, unchanged, or inconclusive.

All action and outcome writes require `business.write`. Reads require `business.read`. Tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 9 can produce professional reports using the complete evidence chain: verified metrics, findings, management actions, and measured outcomes.
