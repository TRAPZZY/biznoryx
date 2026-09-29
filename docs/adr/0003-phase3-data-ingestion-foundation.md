# ADR 0003: Phase 3 Data Ingestion Foundation

## Status

Accepted

## Context

BIZNORYX must treat recurring company data as a governed historical stream, not as unrelated one-off analyses. Before semantic mapping or metric calculation can begin, the platform needs a secure intake foundation that preserves raw evidence, validates untrusted uploads, establishes schema baselines, detects drift, and records lineage.

## Decision

Phase 3 introduces tenant-owned ingestion records:

- data sources
- data streams
- stream schema versions
- reporting periods
- immutable raw data object metadata
- ingestion runs
- validation results

Manual upload intake validates extension, content type, size, row count, columns, and checksum inputs. The first accepted upload establishes a schema baseline for the recurring stream. Later uploads extend the same stream and reporting-period history. Compatible schema changes can proceed, potentially compatible changes are warning-level, and breaking schema drift rejects the run until the mapping is reviewed.

All ingestion writes require `business.write`. Ingestion summaries require `business.read`. All ingestion tables are protected by PostgreSQL RLS with explicit `WITH CHECK`, and the runtime role remains least-privilege with `NOBYPASSRLS`.

## Consequences

Phase 4 can build semantic mapping and deterministic KPI calculation on top of recurring streams, schema versions, reporting periods, raw object lineage, and validation evidence. It must not bypass this ingestion foundation or treat new periods as unrelated analyses.
