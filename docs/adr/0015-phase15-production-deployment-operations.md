# ADR 0015: Phase 15 Production Deployment and Operations

## Status

Accepted

## Context

BIZNORYX has release readiness checks but still needs an operational deployment contract. The repository has not selected a cloud provider, so production operations should define required capabilities without locking the product to a premature provider-specific stack.

## Decision

Phase 15 introduces:

- provider-neutral production deployment manifest
- deployment manifest validation
- deployment health gate
- explicit deploy check script
- production operations and rollback runbook

The deployment manifest requires redundant web and worker services, private data stores, managed secrets, backups, required preflight commands, and rollback configuration.

## Consequences

Provider-specific infrastructure can now implement the manifest contract. Phase 16 can focus on enterprise security and compliance without mixing those controls into deployment mechanics.
