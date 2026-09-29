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
  PostgresPerformanceFindingsRepository,
} from "../src/database/performance-findings-repository.mjs";

import {
  BusinessActionError,
  canTransitionActionStatus,
  PostgresBusinessActionsRepository,
} from "../src/database/business-actions-repository.mjs";

import {
  PostgresBusinessOutcomesRepository,
} from "../src/database/business-outcomes-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env
    .TEST_DATABASE_URL;

test(
  "PostgreSQL verified action accepts its finding and preserves the complete evidence chain",
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

    const actions =
      new PostgresBusinessActionsRepository(
        pool,
      );

    const outcomes =
      new PostgresBusinessOutcomesRepository(
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
              `action-owner-${nonce}@example.com`,

            displayName:
              "Action Owner",

            password:
              "StrongActionPass2026!",
          });

      const outsider =
        await identity
          .createUser({
            email:
              `action-outsider-${nonce}@example.com`,

            displayName:
              "Action Outsider",

            password:
              "StrongActionPass2026!",
          });

      const organization =
        await identity
          .createOrganization({
            actorUserId:
              owner.id,

            name:
              `Action Test ${nonce}`,

            slug:
              `action-${nonce}`
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
              "action-sales",

            displayName:
              "Action sales",

            grain:
              "monthly",
          });

      /*
       * January revenue = 100.
       */

      const januaryContent =
        [
          "product,revenue",
          "A,40.00",
          "B,60.00",
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
                "action-january.csv",

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

      await findings
        .refreshForIngestion({
          organizationId:
            organization.id,

          ingestionRunId:
            january
              .ingestionRun
              .id,
        });

      /*
       * February revenue = 125.
       */

      const februaryContent =
        [
          "product,revenue",
          "A,50.00",
          "B,75.00",
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
                "action-february.csv",

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

      await findings
        .refreshForIngestion({
          organizationId:
            organization.id,

          ingestionRunId:
            february
              .ingestionRun
              .id,
        });

      const findingModules =
        await findings
          .listDashboardModules({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        findingModules
          .opportunities
          .length,
        1,
      );

      const opportunity =
        findingModules
          .opportunities[0];

      assert.equal(
        opportunity
          .findingType,
        "opportunity",
      );

      assert.equal(
        opportunity
          .status,
        "active",
      );

      assert.equal(
        opportunity
          .metric
          .key,
        "sum:revenue",
      );

      /*
       * Convert the evidence-backed finding into
       * a durable business action.
       */

      const createdAction =
        await actions
          .createFromFinding({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            findingId:
              opportunity.id,

            action: {
              title:
                "Investigate drivers of revenue growth",

              description:
                "Identify which verified business drivers contributed to the February revenue increase and decide which can be repeated.",

              dueDate:
                "2026-03-31",
            },
          });

      assert.equal(
        createdAction.status,
        "planned",
      );

      assert.equal(
        createdAction.ownerUserId,
        owner.id,
      );

      assert.equal(
        createdAction.dueDate,
        "2026-03-31",
      );

      assert.equal(
        createdAction
          .sourceFinding
          .id,
        opportunity.id,
      );

      assert.equal(
        createdAction
          .sourceFinding
          .status,
        "accepted",
      );

      assert.equal(
        createdAction
          .sourceFinding
          .findingType,
        "opportunity",
      );

      assert.equal(
        createdAction
          .metric
          .key,
        "sum:revenue",
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingId,
        opportunity.id,
      );

      assert.equal(
        createdAction
          .evidence
          .sourceComparisonId,
        opportunity
          .sourceComparisonId,
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingEvidence
          .previousValue,
        "100",
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingEvidence
          .currentValue,
        "125",
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingEvidence
          .percentChange,
        "25",
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingEvidence
          .previousRawDataObjectId,
        january
          .rawObject
          .id,
      );

      assert.equal(
        createdAction
          .evidence
          .sourceFindingEvidence
          .currentRawDataObjectId,
        february
          .rawObject
          .id,
      );

      /*
       * Action creation must accept the finding
       * transactionally.
       */

      const findingsAfterAction =
        await findings
          .listFindings({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      const acceptedFinding =
        findingsAfterAction
          .find(
            (
              finding,
            ) =>
              finding.id ===
              opportunity.id,
          );

      assert.ok(
        acceptedFinding,
      );

      assert.equal(
        acceptedFinding.status,
        "accepted",
      );

      /*
       * Retry is idempotent.
       */

      const retried =
        await actions
          .createFromFinding({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            findingId:
              opportunity.id,

            action: {
              title:
                "Duplicate command must not create another action",

              description:
                "This payload is deliberately different to prove the durable finding key controls idempotency.",

              dueDate:
                "2026-04-30",
            },
          });

      assert.equal(
        retried.id,
        createdAction.id,
      );

      const listed =
        await actions
          .listActions({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        listed.length,
        1,
      );

      assert.equal(
        listed[0].id,
        createdAction.id,
      );

      assert.equal(
        listed[0].status,
        "planned",
      );

      /*
       * Progress the action using legal state
       * transitions.
       */

      const inProgress =
        await actions
          .updateStatus({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            actionId:
              createdAction.id,

            status:
              "in_progress",
          });

      assert.equal(
        inProgress.status,
        "in_progress",
      );

      assert.equal(
        inProgress.completedAt,
        null,
      );

      const completed =
        await actions
          .updateStatus({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            actionId:
              createdAction.id,

            status:
              "completed",
          });

      assert.equal(
        completed.status,
        "completed",
      );

      assert.ok(
        completed.completedAt,
      );

      /*
       * March revenue = 150.
       *
       * Outcome memory links the progressed or
       * completed action to a later verified KPI
       * measurement without claiming causation.
       */

      const marchContent =
        [
          "product,revenue",
          "A,60.00",
          "B,90.00",
          "",
        ].join(
          "\n",
        );

      const march =
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
                "action-march.csv",

              contentType:
                "text/csv",

              content:
                marchContent,

              byteSize:
                Buffer.byteLength(
                  marchContent,
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
              ],
            },

            reportingPeriod: {
              periodStart:
                "2026-03-01",

              periodEnd:
                "2026-03-31",

              label:
                "March 2026",
            },
          });

      await metrics
        .replaceIngestionMetrics({
          organizationId:
            organization.id,

          ingestionRunId:
            march
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
                "150",

              sourceRowCount:
                2,

              contributingRowCount:
                2,

              evidence: {
                calculation:
                  "sum(revenue)",
              },
            },
          ],
        });

      const refreshedOutcomes =
        await outcomes
          .refreshForAction({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            actionId:
              createdAction.id,
          });

      assert.equal(
        refreshedOutcomes.length,
        1,
      );

      assert.equal(
        refreshedOutcomes[0].status,
        "improved",
      );

      assert.equal(
        refreshedOutcomes[0].baselineValue,
        "125",
      );

      assert.equal(
        refreshedOutcomes[0].laterValue,
        "150",
      );

      assert.equal(
        refreshedOutcomes[0].absoluteChange,
        "25",
      );

      assert.equal(
        refreshedOutcomes[0].percentChange,
        "20",
      );

      assert.equal(
        refreshedOutcomes[0]
          .evidence
          .causationClaimed,
        false,
      );

      assert.equal(
        refreshedOutcomes[0]
          .evidence
          .baselineRawDataObjectId,
        february
          .rawObject
          .id,
      );

      assert.equal(
        refreshedOutcomes[0]
          .evidence
          .laterRawDataObjectId,
        march
          .rawObject
          .id,
      );

      const listedOutcomes =
        await outcomes
          .listOutcomes({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      assert.equal(
        listedOutcomes.length,
        1,
      );

      assert.equal(
        listedOutcomes[0]
          .action
          .id,
        createdAction.id,
      );

      assert.equal(
        listedOutcomes[0]
          .metric
          .key,
        "sum:revenue",
      );

      assert.equal(
        listedOutcomes[0]
          .baselinePeriod
          .label,
        "February 2026",
      );

      assert.equal(
        listedOutcomes[0]
          .laterPeriod
          .label,
        "March 2026",
      );

      /*
       * Completed actions are terminal.
       */

      await assert.rejects(
        () =>
          actions
            .updateStatus({
              organizationId:
                organization.id,

              actorUserId:
                owner.id,

              actionId:
                createdAction.id,

              status:
                "in_progress",
            }),

        (
          error,
        ) =>
          error instanceof
            BusinessActionError &&
          error.code ===
            "ACTION_STATUS_TRANSITION_INVALID",
      );

      /*
       * Cross-tenant reads are denied.
       */

      await assert.rejects(
        () =>
          actions
            .listActions({
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

      /*
       * Cross-tenant action creation is denied
       * before finding details are disclosed.
       */

      await assert.rejects(
        () =>
          actions
            .createFromFinding({
              organizationId:
                organization.id,

              actorUserId:
                outsider.id,

              findingId:
                opportunity.id,

              action: {
                title:
                  "Unauthorized action",
              },
            }),

        (
          error,
        ) =>
          error instanceof
            AuthError &&
          error.code ===
            "ORG_ACCESS_DENIED",
      );

      await assert.rejects(
        () =>
          outcomes
            .listOutcomes({
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

      /*
       * RLS-protected table contains exactly one
       * durable action and one durable outcome.
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
               from verified_business_actions
               where organization_id = $1`,
              [
                organization.id,
              ],
            );

        assert.equal(
          Number(
            countResult
              .rows[0]
              .count,
          ),
          1,
        );

        const outcomeCountResult =
          await databaseClient
            .query(
              `select
                 count(*)::integer as count
               from verified_business_outcomes
               where organization_id = $1`,
              [
                organization.id,
              ],
            );

        assert.equal(
          Number(
            outcomeCountResult
              .rows[0]
              .count,
          ),
          1,
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
           * Preserve original test failure.
           */
        }

        throw error;
      } finally {
        databaseClient
          .release();
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "business action status transitions are deterministic",
  () => {
    assert.equal(
      canTransitionActionStatus(
        "planned",
        "in_progress",
      ),
      true,
    );

    assert.equal(
      canTransitionActionStatus(
        "planned",
        "cancelled",
      ),
      true,
    );

    assert.equal(
      canTransitionActionStatus(
        "planned",
        "completed",
      ),
      false,
    );

    assert.equal(
      canTransitionActionStatus(
        "in_progress",
        "blocked",
      ),
      true,
    );

    assert.equal(
      canTransitionActionStatus(
        "in_progress",
        "completed",
      ),
      true,
    );

    assert.equal(
      canTransitionActionStatus(
        "blocked",
        "in_progress",
      ),
      true,
    );

    assert.equal(
      canTransitionActionStatus(
        "completed",
        "in_progress",
      ),
      false,
    );

    assert.equal(
      canTransitionActionStatus(
        "cancelled",
        "planned",
      ),
      false,
    );
  },
);
