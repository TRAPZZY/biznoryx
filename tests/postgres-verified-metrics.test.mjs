import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  AuthError,
} from "../src/auth/core.mjs";

import {
  PostgresIdentityRepository,
} from "../src/database/identity-repository.mjs";

import {
  PostgresDataIngestionRepository,
} from "../src/database/data-ingestion-repository.mjs";

import {
  PostgresVerifiedMetricsRepository,
} from "../src/database/verified-metrics-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL verified metrics persist evidence-backed tenant series idempotently",
  {
    skip:
      !connectionString,
  },
  async () => {
    const pool =
      new Pool({
        connectionString,
      });

    const identity =
      new PostgresIdentityRepository(
        pool,
        {
          production:
            false,
        },
      );

    const ingestion =
      new PostgresDataIngestionRepository(
        pool,
      );

    const metrics =
      new PostgresVerifiedMetricsRepository(
        pool,
      );

    try {
      const nonce =
        `${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

      const owner =
        await identity.createUser({
          email:
            `metric-owner-${nonce}@example.com`,

          displayName:
            "Metric Acceptance Owner",

          password:
            "StrongMetricPass2026!",
        });

      const outsider =
        await identity.createUser({
          email:
            `metric-outsider-${nonce}@example.com`,

          displayName:
            "Metric Acceptance Outsider",

          password:
            "StrongMetricPass2026!",
        });

      const organization =
        await identity.createOrganization({
          actorUserId:
            owner.id,

          name:
            `Metric Test ${nonce}`,

          slug:
            `metric-${nonce}`
              .toLowerCase()
              .replace(
                /[^a-z0-9-]/g,
                "-",
              )
              .slice(
                0,
                48,
              ),
        });

      const source =
        await ingestion
          .ensureManualUploadSource({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      const stream =
        await ingestion
          .ensureStream({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            dataSourceId:
              source.id,

            name:
              "verified-sales",

            displayName:
              "Verified sales",

            grain:
              "monthly",
          });

      const content =
        [
          "product,revenue,cost",
          "A,10.25,4.00",
          "B,20.05,8.50",
          "",
        ].join(
          "\n",
        );

      const upload =
        await ingestion
          .registerRawUpload({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            dataSourceId:
              source.id,

            dataStreamId:
              stream.id,

            upload: {
              originalFilename:
                "verified-sales.csv",

              contentType:
                "text/csv",

              content,

              byteSize:
                Buffer.byteLength(
                  content,
                ),

              rowCount:
                2,

              columns: [
                {
                  name:
                    "product",

                  type:
                    "text",

                  required:
                    true,
                },

                {
                  name:
                    "revenue",

                  type:
                    "decimal",

                  required:
                    true,
                },

                {
                  name:
                    "cost",

                  type:
                    "decimal",

                  required:
                    true,
                },
              ],
            },

            reportingPeriod: {
              periodStart:
                "2026-09-01",

              periodEnd:
                "2026-09-30",

              label:
                "September 2026",
            },
          });

      assert.equal(
        upload.ingestionRun
          .status,
        "validated",
      );

      const persisted =
        await metrics
          .replaceIngestionMetrics({
            organizationId:
              organization.id,

            ingestionRunId:
              upload.ingestionRun
                .id,

            metrics: [
              {
                metricKey:
                  "sum:revenue",

                label:
                  "Revenue",

                sourceColumn:
                  "revenue",

                aggregation:
                  "sum",

                value:
                  "30.30",

                sourceRowCount:
                  2,

                contributingRowCount:
                  2,

                evidence: {
                  calculation:
                    "sum(revenue)",
                },
              },

              {
                metricKey:
                  "sum:cost",

                label:
                  "Cost",

                sourceColumn:
                  "cost",

                aggregation:
                  "sum",

                value:
                  "12.50",

                sourceRowCount:
                  2,

                contributingRowCount:
                  2,

                evidence: {
                  calculation:
                    "sum(cost)",
                },
              },
            ],
          });

      assert.equal(
        persisted.length,
        2,
      );

      /*
       * Retry the exact same ingestion.
       *
       * This proves the persistence boundary
       * is idempotent: metric points for the
       * ingestion run are replaced instead of
       * duplicated.
       */
      const retried =
        await metrics
          .replaceIngestionMetrics({
            organizationId:
              organization.id,

            ingestionRunId:
              upload.ingestionRun
                .id,

            metrics: [
              {
                metricKey:
                  "sum:revenue",

                label:
                  "Revenue",

                sourceColumn:
                  "revenue",

                aggregation:
                  "sum",

                value:
                  "30.30",

                sourceRowCount:
                  2,

                contributingRowCount:
                  2,

                evidence: {
                  calculation:
                    "sum(revenue)",
                },
              },

              {
                metricKey:
                  "sum:cost",

                label:
                  "Cost",

                sourceColumn:
                  "cost",

                aggregation:
                  "sum",

                value:
                  "12.50",

                sourceRowCount:
                  2,

                contributingRowCount:
                  2,

                evidence: {
                  calculation:
                    "sum(cost)",
                },
              },
            ],
          });

      assert.equal(
        retried.length,
        2,
      );

      /*
       * Read the durable tenant series through
       * the production repository boundary.
       */
      const series =
        await metrics.listSeries({
          organizationId:
            organization.id,

          actorUserId:
            owner.id,
        });

      assert.equal(
        series.length,
        2,
      );

      const revenue =
        series.find(
          (item) =>
            item.metricKey ===
            "sum:revenue",
        );

      assert.ok(
        revenue,
      );

      assert.equal(
        revenue.label,
        "Revenue",
      );

      assert.equal(
        revenue.sourceColumn,
        "revenue",
      );

      assert.equal(
        revenue.aggregation,
        "sum",
      );

      assert.equal(
        revenue.points.length,
        1,
      );

      assert.equal(
        revenue.points[0]
          .value,
        "30.3",
      );

      assert.equal(
        revenue.points[0]
          .sourceRowCount,
        2,
      );

      assert.equal(
        revenue.points[0]
          .contributingRowCount,
        2,
      );

      assert.equal(
        revenue.points[0]
          .evidence
          .calculation,
        "sum(revenue)",
      );

      assert.equal(
        revenue.points[0]
          .evidence
          .checksumSha256,
        upload.rawObject
          .checksumSha256,
      );

      assert.equal(
        revenue.points[0]
          .evidence
          .rawDataObjectId,
        upload.rawObject.id,
      );

      assert.equal(
        revenue.points[0]
          .evidence
          .ingestionRunId,
        upload.ingestionRun.id,
      );

      assert.equal(
        revenue.points[0]
          .evidence
          .dataStreamId,
        stream.id,
      );

      assert.equal(
        revenue.points[0]
          .reportingPeriodId,
        upload.reportingPeriod
          .id,
      );

      const cost =
        series.find(
          (item) =>
            item.metricKey ===
            "sum:cost",
        );

      assert.ok(
        cost,
      );

      assert.equal(
        cost.label,
        "Cost",
      );

      assert.equal(
        cost.points.length,
        1,
      );

      assert.equal(
        cost.points[0]
          .value,
        "12.5",
      );

      /*
       * Series groups must represent the real
       * durable data stream rather than
       * fabricated dashboard grouping.
       */
      const groups =
        await metrics
          .listSeriesGroups({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        groups.length,
        1,
      );

      assert.equal(
        groups[0].id,
        stream.id,
      );

      assert.equal(
        groups[0].name,
        "verified-sales",
      );

      assert.equal(
        groups[0].displayName,
        "Verified sales",
      );

      assert.equal(
        groups[0]
          .seriesIds.length,
        2,
      );

      assert.deepEqual(
        new Set(
          groups[0]
            .seriesIds,
        ),

        new Set(
          series.map(
            (item) =>
              item.id,
          ),
        ),
      );

      /*
       * Direct database verification must use
       * one checked-out PostgreSQL connection.
       *
       * SET LOCAL / set_config(..., true) is
       * transaction-local, so BEGIN, tenant
       * context, SELECT and ROLLBACK cannot be
       * issued through separate pool clients.
       */
      const countClient =
        await pool.connect();

      try {
        await countClient.query(
          "begin",
        );

        await countClient.query(
          `select set_config(
             'app.current_organization_id',
             $1,
             true
           )`,
          [
            organization.id,
          ],
        );

        const countResult =
          await countClient.query(
            `select
               count(*)::integer as count
             from verified_metric_points
             where organization_id = $1`,
            [
              organization.id,
            ],
          );

        assert.equal(
          Number(
            countResult.rows[0]
              .count,
          ),
          2,
        );

        await countClient.query(
          "rollback",
        );
      } catch (error) {
        try {
          await countClient.query(
            "rollback",
          );
        } catch {
          /*
           * Preserve the original
           * test failure.
           */
        }

        throw error;
      } finally {
        countClient.release();
      }

      /*
       * Confirm the two durable definitions
       * were also created exactly once.
       */
      const definitionClient =
        await pool.connect();

      try {
        await definitionClient.query(
          "begin",
        );

        await definitionClient.query(
          `select set_config(
             'app.current_organization_id',
             $1,
             true
           )`,
          [
            organization.id,
          ],
        );

        const definitionCount =
          await definitionClient.query(
            `select
               count(*)::integer as count
             from verified_metric_definitions
             where organization_id = $1`,
            [
              organization.id,
            ],
          );

        assert.equal(
          Number(
            definitionCount
              .rows[0]
              .count,
          ),
          2,
        );

        await definitionClient.query(
          "rollback",
        );
      } catch (error) {
        try {
          await definitionClient.query(
            "rollback",
          );
        } catch {
          /*
           * Preserve the original
           * test failure.
           */
        }

        throw error;
      } finally {
        definitionClient.release();
      }

      /*
       * Cross-organization reads must remain
       * denied at the repository boundary.
       */
      await assert.rejects(
        () =>
          metrics.listSeries({
            organizationId:
              organization.id,

            actorUserId:
              outsider.id,
          }),

        (error) =>
          error instanceof
            AuthError &&
          error.code ===
            "ORG_ACCESS_DENIED",
      );
    } finally {
      await pool.end();
    }
  },
);