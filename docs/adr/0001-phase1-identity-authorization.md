# ADR 0001: Phase 1 Identity, Organizations, and Authorization

## Status

Accepted

## Context

BIZNORYX is a multi-tenant SaaS platform that stores real company performance data. Phase 1 must establish identity, organization boundaries, membership lifecycle, capability-based authorization, session handling, auditability, and database-level tenant isolation before business onboarding or ingestion features begin.

The requested `/mnt/data/biznoryx-production` checkout was unavailable in this workspace. The local implementation therefore reconstructs the production foundation and records the missing checkout as an environment condition.

## Decision

Use a defense-in-depth authorization model:

- application sessions are opaque, hashed at rest, expiring, and revocable
- user identity is separated from organization access
- every tenant-owned record belongs to an organization
- authorization uses capabilities resolved from active memberships rather than scattered hardcoded role checks
- mutating membership and invitation services enforce required capabilities at their own boundary
- organization switching requires active membership
- invitation acceptance is single-use and audited
- disabled members cannot keep using existing sessions for the disabled organization
- PostgreSQL transactions set local `app.current_organization_id` and `app.current_user_id` for RLS
- RLS policies enforce tenant isolation in the database
- audit events are append-only and tenant-scoped where applicable

## Consequences

All future features must call the capability layer before reading or mutating tenant data. Database access for tenant data must run through an organization-aware transaction boundary so pooled connections cannot leak tenant context.
