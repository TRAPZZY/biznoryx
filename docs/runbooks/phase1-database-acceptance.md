# Phase 1 Database Acceptance Runbook

## Purpose

This runbook proves the Phase 1 tenant-security gate for BIZNORYX. It must pass before Phase 2 begins.

The gate verifies:

- Phase 1 migrations apply cleanly
- the runtime database role exists with `NOBYPASSRLS`
- tenant reads are scoped by `app.current_organization_id`
- tenant writes are blocked by RLS `WITH CHECK`
- default-deny behavior applies when tenant context is missing

## Local Prerequisites

Install one of:

- Docker with Compose
- Podman with Compose-compatible support
- PostgreSQL client tools with `psql`

## Local Docker Path

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Set environment variables:

```bash
export DATABASE_URL="postgresql://biznoryx_admin:biznoryx_local_password@localhost:5432/biznoryx"
export BIZNORYX_APP_DB_PASSWORD="replace-with-local-runtime-password"
```

Run the full gate:

```bash
npm run verify
npm run db:acceptance
```

## Expected Result

Both commands must exit with code `0`.

`npm run db:acceptance` applies:

1. `db/migrations/0001_foundation.sql`
2. `db/migrations/0002_phase1_identity_org_auth.sql`
3. `db/bootstrap/001_runtime_role.sql`
4. `db/acceptance/phase1_rls_acceptance.sql`

The runner uses `DATABASE_URL` as the target in both host `psql` mode and Docker fallback mode. For local re-runs, prefer a clean disposable database when the shared `biznoryx` database may already contain objects from previous acceptance runs.

## Failure Handling

Do not start Phase 2 if this gate fails.

Fix the failing migration, policy, bootstrap grant, runtime-role configuration, or acceptance assertion. Then rerun both commands from a clean database.

## CI

`.github/workflows/phase1.yml` runs the same gate against PostgreSQL 18.
