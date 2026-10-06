# Evidence report enhancements rollout

Features: Revenue Change Breakdown and Guided Report Explainer.

## Northflank rollout

1. Back up the production database using the existing operator procedure. Keep the currently deployed runtime running.
2. Apply `db/migrations/0030_evidence_revenue_breakdown.sql` once using the database migration/admin connection, after migrations 0027-0029. Use the same reviewed migration job/terminal procedure used for those migrations. Do not replay all historical migrations against a populated database.
3. Verify the migration completed successfully. It adds nullable `revenue_breakdown` JSONB and a validation constraint to the existing tenant-isolated `evidence_report_definitions` table. Existing definitions remain valid and existing runtime permissions cover the new column.
4. Merge the reviewed feature branch and deploy the updated web runtime and worker from the same commit. No new environment variables, credentials or model integrations are required.
5. Open Evidence reports, then Metric definition. Confirm the revenue metric, product identifier, quantity column, common quantity unit and reporting currency. Save a new version. Select two complete observed periods and verify the effects reconcile to the total change.
6. Check the guided questions, evidence links and PDF/HTML/CSV downloads, including a report without enough quantity/product history. Missing evidence must be explained without blocking the ordinary report.

Existing report aggregates are reused. Older stored aggregates lacking product detail or a matching quantity metric cannot support the breakdown; provide a suitable dated recurring source through the normal ingestion workflow. Do not rewrite immutable raw files or silently replace historical KPI definitions. The updated worker retains single-product identifiers and SKU/item dimensions within the existing analytics budget.

This runbook describes operator work, not evidence that the live Northflank database or deployment has been changed by Codex.

## Rollback

Roll back the web runtime and worker to the prior commit first. Leaving the additive nullable column in place is compatible with the old runtime. If removing the column is necessary, export/back up the approved mappings before applying `0030_evidence_revenue_breakdown.down.sql`; dropping it permanently removes those mappings. Never drop it while the new runtime is running.

## Local verification

Run `npm run verify` and `npm run test:browser`. Run `node --test tests/postgres-evidence-report.test.mjs` with `TEST_DATABASE_URL` pointing to a disposable migrated database using the restricted `biznoryx_app` role. That test checks persistence, immutable prior versions, concurrency, viewer restrictions, tenant isolation, and production HTTP route behavior. Upstream verified-series, session and billing fixtures in its HTTP checks are synthetic test fixtures; the definition repository and tenant policies are real PostgreSQL.
