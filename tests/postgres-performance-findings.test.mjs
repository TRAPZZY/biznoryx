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
  PostgresMetricComparisonRepository,
} from "../src/database/metric-comparison-repository.mjs";

import {
  classifyMetricPolarity,
  findingSeverity,
  PostgresPerformanceFindingsRepository,
} from "../src/database/performance-findings-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env
    .TEST_DATABASE_URL;

test(
  "PostgreSQL findings derive only evidence-backed tenant intelligence from ready comparisons",
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

    const findings =
      new PostgresPerformanceFindingsRepository(
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
              `finding-owner-${nonce}@example.com`,

            displayName:
              "Finding Owner",

            password:
              "StrongFindingPass2026!",
          });

      const outsider =
        await identity
          .createUser({
            email:
              `finding-outsider-${nonce}@example.com`,

            displayName:
              "Finding Outsider",

            password:
              "StrongFindingPass2026!",
          });

      const organization =
        await identity
          .createOrganization({
            actorUserId:
              owner.id,

            name:
              `Finding Test ${nonce}`,

            slug:
              `finding-${nonce}`
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
              "finding-sales",

            displayName:
              "Finding sales",

            grain:
              "monthly",
          });

      /*
       * January baseline:
       *
       * revenue = 100
       * cost    = 50
       */
      const januaryContent =
        [
          "product,revenue,cost",
          "A,40.00,20.00",
          "B,60.00,30.00",
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
                "finding-january.csv",

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
                "50",

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
            january
              .ingestionRun
              .id,
        });

      /*
       * First period comparisons are not-ready,
       * therefore no findings are allowed.
       */
      const januaryFindings =
        await findings
          .refreshForIngestion({
            organizationId:
              organization.id,

            ingestionRunId:
              january
                .ingestionRun
                .id,
          });

      assert.deepEqual(
        januaryFindings,
        [],
      );

      const januaryModules =
        await findings
          .listDashboardModules({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.deepEqual(
        januaryModules,
        {
          signals:
            [],

          risks:
            [],

          opportunities:
            [],

          focusAreas:
            [],
        },
      );

      /*
       * February:
       *
       * revenue 100 -> 125 = +25%
       *
       * Exact "revenue" semantics are explicitly
       * higher-is-better, therefore this can create
       * an opportunity.
       *
       * cost 50 -> 60 = +20%
       *
       * Exact "cost" semantics are explicitly
       * lower-is-better, therefore this can create
       * a risk.
       */
      const februaryContent =
        [
          "product,revenue,cost",
          "A,50.00,25.00",
          "B,75.00,35.00",
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
                "finding-february.csv",

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
                "60",

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

      const persisted =
        await findings
          .refreshForIngestion({
            organizationId:
              organization.id,

            ingestionRunId:
              february
                .ingestionRun
                .id,
          });

      /*
       * Revenue:
       * signal + opportunity + focus area
       *
       * Cost:
       * signal + risk + focus area
       */
      assert.equal(
        persisted.length,
        6,
      );

      /*
       * Retry the exact same findings refresh.
       *
       * Unique metric/period/type keys make this
       * idempotent.
       */
      await findings
        .refreshForIngestion({
          organizationId:
            organization.id,

          ingestionRunId:
            february
              .ingestionRun
              .id,
        });

      const allFindings =
        await findings
          .listFindings({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        allFindings.length,
        6,
      );

      const modules =
        await findings
          .listDashboardModules({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        modules.signals
          .length,
        2,
      );

      assert.equal(
        modules.risks
          .length,
        1,
      );

      assert.equal(
        modules.opportunities
          .length,
        1,
      );

      assert.equal(
        modules.focusAreas
          .length,
        2,
      );

      const revenueOpportunity =
        modules
          .opportunities
          .find(
            (
              finding,
            ) =>
              finding.metric
                .key ===
              "sum:revenue",
          );

      assert.ok(
        revenueOpportunity,
      );

      assert.equal(
        revenueOpportunity
          .severity,
        "high",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .metricPolarity,
        "higher_is_better",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .previousValue,
        "100",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .currentValue,
        "125",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .absoluteChange,
        "25",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .percentChange,
        "25",
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .previousRawDataObjectId,
        january
          .rawObject
          .id,
      );

      assert.equal(
        revenueOpportunity
          .evidence
          .currentRawDataObjectId,
        february
          .rawObject
          .id,
      );

      assert.equal(
        revenueOpportunity
          .reportingPeriod
          .label,
        "February 2026",
      );

      const costRisk =
        modules.risks
          .find(
            (
              finding,
            ) =>
              finding.metric
                .key ===
              "sum:cost",
          );

      assert.ok(
        costRisk,
      );

      assert.equal(
        costRisk.severity,
        "medium",
      );

      assert.equal(
        costRisk
          .evidence
          .metricPolarity,
        "lower_is_better",
      );

      assert.equal(
        costRisk
          .evidence
          .previousValue,
        "50",
      );

      assert.equal(
        costRisk
          .evidence
          .currentValue,
        "60",
      );

      assert.equal(
        costRisk
          .evidence
          .absoluteChange,
        "10",
      );

      assert.equal(
        costRisk
          .evidence
          .percentChange,
        "20",
      );

      /*
       * Outsider cannot read another tenant's
       * intelligence.
       */
      await assert.rejects(
        () =>
          findings
            .listDashboardModules({
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
  "performance finding semantic classification is narrow and deterministic",
  () => {
    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:revenue",

        sourceColumn:
          "revenue",
      }),
      "higher_is_better",
    );

    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:cost",

        sourceColumn:
          "cost",
      }),
      "lower_is_better",
    );

    /*
     * Quantity is intentionally neutral.
     *
     * More units may be favorable or unfavorable
     * depending on the business context.
     */
    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:quantity",

        sourceColumn:
          "quantity",
      }),
      "neutral",
    );

    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:custom_score",

        sourceColumn:
          "custom_score",
      }),
      "neutral",
    );
  },
);

test(
  "performance finding severity thresholds are deterministic",
  () => {
    assert.equal(
      findingSeverity({
        percentChange:
          "25",

        absoluteChange:
          "25",
      }),
      "high",
    );

    assert.equal(
      findingSeverity({
        percentChange:
          "-24.99",

        absoluteChange:
          "-20",
      }),
      "medium",
    );

    assert.equal(
      findingSeverity({
        percentChange:
          "10",

        absoluteChange:
          "5",
      }),
      "medium",
    );

    assert.equal(
      findingSeverity({
        percentChange:
          "9.99",

        absoluteChange:
          "5",
      }),
      "low",
    );

    assert.equal(
      findingSeverity({
        percentChange:
          "0",

        absoluteChange:
          "0",
      }),
      "info",
    );

    /*
     * Zero-baseline comparisons cannot provide
     * a percentage, but a real absolute movement
     * still exists.
     */
    assert.equal(
      findingSeverity({
        percentChange:
          null,

        absoluteChange:
          "10",
      }),
      "low",
    );
  },
);