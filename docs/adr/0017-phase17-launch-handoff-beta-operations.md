# ADR 0017: Phase 17 Launch Handoff and Beta Operations

## Status

Accepted

## Context

The repository has product, release, deployment, and compliance readiness gates. A launch still needs human handoff controls so beta customers are not admitted without support ownership, scope limits, known limitations, and accountable final approval.

## Decision

Phase 17 introduces:

- launch handoff manifest
- launch manifest validation
- launch gate script
- private beta scope limits
- customer handoff and go/no-go runbook

The launch gate requires release readiness, deployment readiness, compliance readiness, and final accountable launch approval. This is a beta operations gate, not a claim that provider-specific infrastructure or external compliance audits have been completed.

## Consequences

BIZNORYX can now be handed to a controlled beta under explicit operational limits. Broader public launch work should be scoped around real infrastructure provisioning, real customer contracts, external audit requirements, and customer-specific integrations.
