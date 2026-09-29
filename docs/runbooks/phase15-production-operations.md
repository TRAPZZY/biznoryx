# Phase 15 Production Deployment and Operations Runbook

## Purpose

This runbook defines the minimum operational process for deploying BIZNORYX to production after release readiness is satisfied.

## Preflight

Run all gates before deployment:

```bash
npm run verify
npm run db:acceptance
npm run release:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DB_ACCEPTANCE_READY=true npm run deploy:check
```

Use real production environment variables for `release:check`. Use the deployment manifest at `deploy/production.manifest.json` as the provider-neutral contract for the target platform.

## Required Runtime Shape

- at least two web replicas
- at least two worker replicas
- private PostgreSQL networking
- PostgreSQL backups enabled with at least 14 days retention
- private object storage
- managed secret provider
- blue-green or rolling release strategy
- rollback enabled and documented

## Deployment Steps

1. Confirm there are no active incidents blocking deployment.
2. Run release readiness and database acceptance against the release candidate.
3. Run `deploy:check` with readiness flags set by the successful gates.
4. Apply migrations before shifting production traffic.
5. Shift traffic using the configured blue-green or rolling strategy.
6. Confirm health checks and worker lease activity.
7. Keep the previous release available until post-deploy checks pass.

## Rollback

Rollback when health checks fail, migrations fail, worker leasing stalls, authentication/session checks regress, or RLS acceptance fails.

1. Stop traffic shift immediately.
2. Return traffic to the previous healthy release.
3. Pause workers for the failed release.
4. Preserve logs and audit records.
5. Run rollback migrations only when the failed migration changed schema and the rollback has been reviewed.
6. Re-run `npm run db:acceptance` before another deployment attempt.
