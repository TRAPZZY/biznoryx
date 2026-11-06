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

import { PostgresEvidenceReportRepository } from "../src/database/evidence-report-repository.mjs";
import { buildBusinessReport } from "../src/reports/evidence-engine.mjs";
import { reportSourcesFromSeries } from "../src/reports/production-sources.mjs";

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

      const policies = new PostgresEvidenceReportRepository(pool);
      const tenant = { organizationId: organization.id, actorUserId: owner.id };
      const refresh = () => findings.refreshForIngestion({
        organizationId: organization.id, ingestionRunId: february.ingestionRun.id,
      });
      const unconfirmed = await refresh();
      assert.equal(unconfirmed.length, 4);
      assert.ok(unconfirmed.every((finding) => finding.evidence.interpretationStatus === "unconfirmed"));
      assert.ok(unconfirmed.every((finding) => finding.evidence.metricPolarity === "neutral"));

      // Stream names, different source columns and another tenant cannot authorize this series.
      const otherOrganization = await identity.createOrganization({
        actorUserId: outsider.id, name: "Other findings organization", slug: `finding-other-${nonce}`.slice(0, 48),
      });
      for (const scope of [
        { ...tenant, seriesKey: stream.name, column: "revenue" },
        { ...tenant, seriesKey: stream.id, column: "Revenue" },
        { organizationId: otherOrganization.id, actorUserId: outsider.id, seriesKey: stream.id, column: "revenue" },
      ]) {
        await policies.approvePolicy({ ...scope, expectedVersion: 0,
          definition: { label: "Unrelated policy", unit: "currency", polarity: "lower", materialityPercent: 5 } });
      }
      assert.equal((await refresh()).length, 4);
      assert.deepEqual(await findings.refreshForIngestion({
        organizationId: otherOrganization.id, ingestionRunId: february.ingestionRun.id,
      }), []);

      for (const [column, polarity, label] of [
        ["revenue", "higher", "Revenue"],
        ["cost", "lower", "Cost"],
      ]) {
        await policies.approvePolicy({
          organizationId: organization.id,
          actorUserId: owner.id,
          seriesKey: stream.id,
          column,
          expectedVersion: 0,
          definition: { label, unit: "number", polarity, materialityPercent: 5 },
        });
      }

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

      const definition = { label: "Recorded receipts", unit: "currency", polarity: "lower", materialityPercent: 30 };
      const approveRevenue = (expectedVersion, override = {}) => policies.approvePolicy({
        ...tenant, seriesKey: stream.id, column: "revenue", expectedVersion,
        definition: { ...definition, ...override },
      });
      await approveRevenue(1);
      await refresh();
      const belowThreshold = await findings.listDashboardModules(tenant);
      assert.equal(belowThreshold.opportunities.length, 0);
      assert.equal(belowThreshold.risks.length, 1); // Cost only; revenue is below its approved threshold.

      await approveRevenue(2, { materialityPercent: 5 });
      await refresh();
      const reversed = await findings.listDashboardModules(tenant);
      assert.equal(reversed.opportunities.length, 0);
      const receiptsRisk = reversed.risks.find((finding) => finding.metric.sourceColumn === "revenue");
      assert.ok(receiptsRisk);
      assert.equal(receiptsRisk.metric.label, "Recorded receipts");
      assert.equal(receiptsRisk.metric.unit, "currency");
      assert.equal(receiptsRisk.evidence.metricPolarity, "lower_is_better");
      assert.equal(receiptsRisk.evidence.metricPolicy.version, 3);
      assert.equal(receiptsRisk.evidence.metricPolicy.approvedByUserId, owner.id);
      assert.equal(receiptsRisk.evidence.metricPolicy.seriesKey, stream.id);
      assert.equal(receiptsRisk.evidence.absoluteChange, "25");
      const report = buildBusinessReport({
        sources: reportSourcesFromSeries(await metrics.listSeries(tenant)),
        policies: await policies.listPolicies(tenant),
        options: { source: february.ingestionRun.id, metric: "revenue" },
      });
      assert.equal(report.metric.policy.version, receiptsRisk.evidence.metricPolicy.version);
      assert.equal(report.metric.policy.polarity, receiptsRisk.evidence.metricPolicy.polarity);
      assert.equal(report.metric.label, receiptsRisk.metric.label);
      assert.equal(report.health, "deteriorating");

      await approveRevenue(3, { polarity: "neutral", materialityPercent: 5 });
      await refresh();
      const neutral = await findings.listDashboardModules(tenant);
      assert.equal(neutral.opportunities.length, 0);
      assert.equal(neutral.risks.length, 1);
      const neutralSignal = neutral.signals.find((finding) => finding.metric.sourceColumn === "revenue");
      assert.equal(neutralSignal.evidence.metricPolarity, "neutral");
      assert.equal(neutralSignal.evidence.metricPolicy.version, 4);
      assert.equal(neutralSignal.evidence.interpretationStatus, "approved");

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
  "performance finding polarity requires an approved definition instead of header semantics",
  () => {
    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:revenue",

        sourceColumn:
          "revenue",
      }),
      "neutral",
    );

    assert.equal(
      classifyMetricPolarity({
        metricKey:
          "sum:cost",

        sourceColumn:
          "cost",
      }),
      "neutral",
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

    assert.equal(classifyMetricPolarity({ approvedPolicy: { polarity: "higher" } }), "higher_is_better");
    assert.equal(classifyMetricPolarity({ approvedPolicy: { polarity: "lower" } }), "lower_is_better");
    assert.equal(classifyMetricPolarity({ approvedPolicy: { polarity: "neutral" } }), "neutral");

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
