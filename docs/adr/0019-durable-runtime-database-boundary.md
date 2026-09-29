# ADR 0019: Durable Runtime Database Boundary

## Status

Accepted for the first durable runtime slice. Public production remains blocked until the HTTP, storage and worker boundaries use durable implementations.

## Context

The review application demonstrated the customer journey with process-memory stores. That runtime intentionally refuses production because accounts, sessions, tenant state and uploads disappear on restart. The existing PostgreSQL schema enforces tenant RLS, but authentication and organization discovery occur before an active tenant is known.

## Decision

Use the official `pg` client with one bounded application pool. Every multi-statement operation uses one checked-out client and explicit begin, commit and rollback handling. Tenant operations set `app.current_organization_id` and `app.current_user_id` as transaction-local values before accessing RLS-protected rows.

Authentication uses narrow security-definer database functions for opaque session lookup and active-membership discovery. Public execution is revoked and granted only to the runtime role. Membership discovery additionally requires matching user context. Password verification remains in the application process; only password hashes are stored.

Persist only hashed session and CSRF tokens. A restored browser session rotates its CSRF token and updates the stored hash; the clear token is never recoverable from the database.

Keep the in-memory HTTP runtime guarded against production until every route has a durable repository. Do not create a serialized process snapshot or claim that local disk state is a production database.

## Consequences

Identity, sessions, organizations and tenant switching now have a tested durable repository boundary. Registration identities are case-insensitively unique, audit reads are tenant-scoped, and the runtime role cannot update audit history.

Profile, ingestion, metric, object-storage and worker repositories must be completed before the PostgreSQL runtime can replace the review server. Production also requires managed PostgreSQL TLS configuration, private networking, secret delivery, backups and restore evidence.
