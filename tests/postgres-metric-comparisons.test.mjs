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

import {
  calculateMetricChange,
  PostgresMetricComparisonRepository,
} from "../src/database/metric-comparison-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env
    .TEST_DATABASE_URL;

test(
  "PostgreSQL metric comparisons build durable tenant trends from verified periods",
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

    const comparisons =
      new PostgresMetricComparisonRepository(
        pool,
      );

    try {
      const nonce =
        `${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

      const owner =
        await identity
          .createUser({
            email:
              `comparison-owner-${nonce}@example.com`,

            displayName:
              "Comparison Owner",

            password:
              "StrongComparisonPass2026!",
          });

      const outsider =
        await identity
          .createUser({
            email:
              `comparison-outsider-${nonce}@example.com`,

            displayName:
              "Comparison Outsider",

            password:
              "StrongComparisonPass2026!",
          });

      const organization =
        await identity
          .createOrganization({
            actorUserId:
              owner.id,

            name:
              `Comparison Test ${nonce}`,

            slug:
              `comparison-${nonce}`
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
              "comparison-sales",

            displayName:
              "Comparison sales",

            grain:
              "monthly",
          });

      /*
       * January:
       *
       * revenue = 100
       * cost = 0
       */
      const januaryContent =
        [
          "product,revenue,cost",
          "A,40.00,0.00",
          "B,60.00,0.00",
          "",
        ].join(
          "\n",
        );

      const january =
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
                "comparison-january.csv",

              contentType:
                "text/csv",

              content:
                januaryContent,

              byteSize:
                Buffer.byteLength(
                  januaryContent,
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
                "2026-01-01",

              periodEnd:
                "2026-01-31",

              label:
                "January 2026",
            },
          });

      await metrics
        .replaceIngestionMetrics({
          organizationId:
            organization.id,

          ingestionRunId:
            january
              .ingestionRun
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
                "100",

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
                "0",

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

      const januaryComparisons =
        await comparisons
          .refreshForIngestion({
            organizationId:
              organization.id,

            ingestionRunId:
              january
                .ingestionRun
                .id,
          });

      assert.equal(
        januaryComparisons
          .length,
        2,
      );

      assert.ok(
        januaryComparisons
          .every(
            (
              comparison,
            ) =>
              comparison.status ===
                "not_ready" &&
              comparison.direction ===
                "not_ready" &&
              comparison.previousValue ===
                null &&
              comparison.percentChange ===
                null,
          ),
      );

      const firstTrendRows =
        await comparisons
          .listTrendRows({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        firstTrendRows.length,
        2,
      );

      assert.ok(
        firstTrendRows
          .every(
            (
              row,
            ) =>
              row.status ===
              "not_ready",
          ),
      );

      /*
       * February:
       *
       * revenue = 125
       * cost = 10
       *
       * revenue:
       * absolute = +25
       * percent = +25%
       *
       * cost:
       * absolute = +10
       * percent = null because previous = 0
       */
      const februaryContent =
        [
          "product,revenue,cost",
          "A,50.00,4.00",
          "B,75.00,6.00",
          "",
        ].join(
          "\n",
        );

      const february =
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
                "comparison-february.csv",

              contentType:
                "text/csv",

              content:
                februaryContent,

              byteSize:
                Buffer.byteLength(
                  februaryContent,
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
                "2026-02-01",

              periodEnd:
                "2026-02-28",

              label:
                "February 2026",
            },
          });

      await metrics
        .replaceIngestionMetrics({
          organizationId:
            organization.id,

          ingestionRunId:
            february
              .ingestionRun
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
                "125",

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
                "10",

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

      await comparisons
        .refreshForIngestion({
          organizationId:
            organization.id,

          ingestionRunId:
            february
              .ingestionRun
              .id,
        });

      const trendRows =
        await comparisons
          .listTrendRows({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        trendRows.length,
        2,
      );

      const revenue =
        trendRows.find(
          (
            row,
          ) =>
            row.metricKey ===
            "sum:revenue",
        );

      assert.ok(
        revenue,
      );

      assert.equal(
        revenue.status,
        "ready",
      );

      assert.equal(
        revenue.direction,
        "up",
      );

      assert.equal(
        revenue.previousValue,
        "100",
      );

      assert.equal(
        revenue.currentValue,
        "125",
      );

      assert.equal(
        revenue.absoluteChange,
        "25",
      );

      assert.equal(
        revenue.percentChange,
        "25",
      );

      assert.equal(
        revenue
          .previousPeriod
          .label,
        "January 2026",
      );

      assert.equal(
        revenue
          .currentPeriod
          .label,
        "February 2026",
      );

      assert.equal(
        revenue
          .evidence
          .previousRawDataObjectId,
        january
          .rawObject
          .id,
      );

      assert.equal(
        revenue
          .evidence
          .currentRawDataObjectId,
        february
          .rawObject
          .id,
      );

      const cost =
        trendRows.find(
          (
            row,
          ) =>
            row.metricKey ===
            "sum:cost",
        );

      assert.ok(
        cost,
      );

      assert.equal(
        cost.status,
        "ready",
      );

      assert.equal(
        cost.direction,
        "up",
      );

      assert.equal(
        cost.previousValue,
        "0",
      );

      assert.equal(
        cost.currentValue,
        "10",
      );

      assert.equal(
        cost.absoluteChange,
        "10",
      );

      assert.equal(
        cost.percentChange,
        null,
      );

      /*
       * Each metric now has:
       *
       * January -> not_ready
       * February -> ready
       */
      const databaseClient =
        await pool.connect();

      try {
        await databaseClient
          .query(
            "begin",
          );

        await databaseClient
          .query(
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
          await databaseClient
            .query(
              `select
                 count(*)::integer as count
               from verified_metric_comparisons
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
          4,
        );

        await databaseClient
          .query(
            "rollback",
          );
      } catch (error) {
        try {
          await databaseClient
            .query(
              "rollback",
            );
        } catch {
          /*
           * Preserve original test error.
           */
        }

        throw error;
      } finally {
        databaseClient
          .release();
      }

      /*
       * Cross-tenant trend reads remain denied.
       */
      await assert.rejects(
        () =>
          comparisons
            .listTrendRows({
              organizationId:
                organization.id,

              actorUserId:
                outsider.id,
            }),

        (
          error,
        ) =>
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

test(
  "metric comparison calculation is deterministic for up down flat and zero baseline",
  () => {
    assert.deepEqual(
      calculateMetricChange({
        previousValue:
          "100",

        currentValue:
          "125",
      }),

      {
        previousValue:
          "100",

        currentValue:
          "125",

        absoluteChange:
          "25",

        percentChange:
          "25",

        direction:
          "up",
      },
    );

    assert.deepEqual(
      calculateMetricChange({
        previousValue:
          "100",

        currentValue:
          "75",
      }),

      {
        previousValue:
          "100",

        currentValue:
          "75",

        absoluteChange:
          "-25",

        percentChange:
          "-25",

        direction:
          "down",
      },
    );

    assert.deepEqual(
      calculateMetricChange({
        previousValue:
          "100",

        currentValue:
          "100",
      }),

      {
        previousValue:
          "100",

        currentValue:
          "100",

        absoluteChange:
          "0",

        percentChange:
          "0",

        direction:
          "flat",
      },
    );

    assert.deepEqual(
      calculateMetricChange({
        previousValue:
          "0",

        currentValue:
          "10",
      }),

      {
        previousValue:
          "0",

        currentValue:
          "10",

        absoluteChange:
          "10",

        percentChange:
          null,

        direction:
          "up",
      },
    );

    assert.deepEqual(
      calculateMetricChange({
        previousValue:
          "-100",

        currentValue:
          "-50",
      }),

      {
        previousValue:
          "-100",

        currentValue:
          "-50",

        absoluteChange:
          "50",

        percentChange:
          "50",

        direction:
          "up",
      },
    );
  },
);