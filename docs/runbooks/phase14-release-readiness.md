# Phase 14 Release Readiness Runbook

## Purpose

This runbook defines the minimum checks required before BIZNORYX can be called production-ready for a real deployment environment.

## Required Gates

Run these checks from a clean workspace:

```bash
npm run verify
npm run db:acceptance
npm run release:check
```

`npm run release:check` must be executed with real production environment variables. It intentionally fails for local database URLs, short secrets, non-HTTPS public URLs, unsupported secret providers, or missing storage configuration.

## Required Production Settings

- `NODE_ENV=production`
- `DATABASE_URL` points to a managed PostgreSQL database, not localhost
- `BIZNORYX_APP_DB_PASSWORD` is rotated away from local defaults
- `BIZNORYX_SESSION_SECRET` and `BIZNORYX_CSRF_SECRET` are at least 32 characters
- `BIZNORYX_PUBLIC_URL` uses HTTPS
- private object storage bucket and region are configured
- secrets are stored in a supported managed provider

## Release Decision

Do not release when any gate fails. Fix the root cause, rerun all gates, and update `BUILD_STATUS.md` only after fresh evidence exists.
