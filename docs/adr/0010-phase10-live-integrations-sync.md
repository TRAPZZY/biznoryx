# ADR 0010: Phase 10 Live Integrations and Synchronization

## Status

Accepted

## Context

BIZNORYX must support live integrations without inventing provider APIs or storing raw credentials in application records. The first production slice should create the governed synchronization control plane that future provider-specific integrations can use.

## Decision

Phase 10 introduces:

- integration connection records
- sync run records with idempotency keys
- webhook event records with payload fingerprints
- secret references instead of raw secrets
- connector status and sync status lifecycles
- dashboard integration freshness visibility

The implementation does not call third-party APIs. Provider-specific fetch, OAuth, and webhook signature verification must be implemented only after official provider documentation and credentials are available.

All connection and sync mutations require `business.write`. Reads require `business.read`. Tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 11 can build alerts and monitoring on top of sync freshness, failed syncs, data health, and existing business findings.
