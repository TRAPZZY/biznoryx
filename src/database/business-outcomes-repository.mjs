import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  calculateMetricChange,
} from "./metric-comparison-repository.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const ASSESSABLE_ACTION_STATUSES =
  new Set([
    "in_progress",
    "completed",
  ]);

export class PostgresBusinessOutcomesRepository {
  constructor(
    pool,
  ) {
    if (!pool) {
      throw new TypeError(
        "PostgreSQL pool is required.",
      );
    }

    this.pool =
      pool;
  }

  async refreshForAction({
    organizationId,
    actorUserId,
    actionId,
  }) {
    validateIdentifier(
      organizationId,
      "Organization is required.",
    );

    validateIdentifier(
      actorUserId,
      "Actor user is required.",
    );

    validateIdentifier(
      actionId,
      "Action is required.",
    );

    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (
        client,
      ) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        const action =
          await selectActionContext({
            client,
            organizationId,
            actionId,
          });

        if (!action) {
          throw new AuthError(
            "Action was not found.",
            "ORG_ACCESS_DENIED",
          );
        }

        if (
          !ASSESSABLE_ACTION_STATUSES.has(
            action.status,
          )
        ) {
          return [];
        }

        const baselineMetricPointId =
          action
            .finding_evidence
            ?.currentMetricPointId;

        if (
          !baselineMetricPointId
        ) {
          throw new BusinessOutcomeError(
            "Action evidence is missing the baseline verified metric point.",
            "OUTCOME_BASELINE_MISSING",
          );
        }

        const baseline =
          await selectMetricPoint({
            client,
            organizationId,
            metricPointId:
              baselineMetricPointId,
          });

        if (!baseline) {
          throw new BusinessOutcomeError(
            "Baseline verified metric point was not found.",
            "OUTCOME_BASELINE_MISSING",
          );
        }

        if (
          baseline
            .metric_definition_id !==
          action.metric_definition_id
        ) {
          throw new BusinessOutcomeError(
            "Action baseline does not match the action metric definition.",
            "OUTCOME_BASELINE_CONFLICT",
          );
        }

        const laterPoints =
          await selectLaterMetricPoints({
            client,
            organizationId,
            metricDefinitionId:
              action.metric_definition_id,
            baselinePeriodStart:
              baseline.period_start,
          });

        const outcomes =
          [];

        for (
          const later of laterPoints
        ) {
          const change =
            calculateMetricChange({
              previousValue:
                baseline.value_numeric,

              currentValue:
                later.value_numeric,
            });

          const status =
            classifyOutcomeStatus({
              direction:
                change.direction,

              metricPolarity:
                action
                  .finding_evidence
                  ?.metricPolarity,
            });

          const evidence =
            buildOutcomeEvidence({
              action,
              baseline,
              later,
              change,
              status,
            });

          const persisted =
            await client.query(
              `insert into verified_business_outcomes (
                 organization_id,
                 business_action_id,
                 metric_definition_id,
                 baseline_metric_point_id,
                 later_metric_point_id,
                 baseline_reporting_period_id,
                 later_reporting_period_id,
                 status,
                 baseline_value_numeric,
                 later_value_numeric,
                 absolute_change_numeric,
                 percent_change_numeric,
                 evidence
               )
               values (
                 $1,
                 $2,
                 $3,
                 $4,
                 $5,
                 $6,
                 $7,
                 $8,
                 $9::numeric,
                 $10::numeric,
                 $11::numeric,
                 $12::numeric,
                 $13::jsonb
               )
               on conflict (
                 organization_id,
                 business_action_id,
                 later_metric_point_id
               )
               do update set
                 status =
                   excluded.status,

                 baseline_value_numeric =
                   excluded.baseline_value_numeric,

                 later_value_numeric =
                   excluded.later_value_numeric,

                 absolute_change_numeric =
                   excluded.absolute_change_numeric,

                 percent_change_numeric =
                   excluded.percent_change_numeric,

                 evidence =
                   excluded.evidence,

               assessed_at =
                 now(),

                 updated_at =
                   now()

               returning
                 id,
                 organization_id,
                 business_action_id,
                 metric_definition_id,
                 baseline_metric_point_id,
                 later_metric_point_id,
                 baseline_reporting_period_id,
                 later_reporting_period_id,
                 status,
                 baseline_value_numeric,
                 later_value_numeric,
                 absolute_change_numeric,
                 percent_change_numeric,
                 evidence,
                 assessed_at,
                 created_at,
                 updated_at`,
              [
                organizationId,
                actionId,
                action.metric_definition_id,
                baseline.id,
                later.id,
                baseline.reporting_period_id,
                later.reporting_period_id,
                status,
                change.previousValue,
                change.currentValue,
                change.absoluteChange,
                change.percentChange,
                JSON.stringify(
                  evidence,
                ),
              ],
            );

          outcomes.push(
            mapOutcome(
              persisted.rows[0],
            ),
          );
        }

        return outcomes;
      },
    );
  }

  async refreshForOrganization({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (
        client,
      ) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `select
               id
             from verified_business_actions
             where organization_id = $1
               and status in (
                 'in_progress',
                 'completed'
               )
             order by updated_at asc,
               id asc`,
            [
              organizationId,
            ],
          );

        const outcomes =
          [];

        for (
          const row of result.rows
        ) {
          outcomes.push(
            ...await this.refreshForAction({
              organizationId,
              actorUserId,
              actionId:
                row.id,
            }),
          );
        }

        return outcomes;
      },
    );
  }

  async listOutcomes({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (
        client,
      ) => {
        await requireReadAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `select
               o.*,
               a.title as action_title,
               a.status as action_status,
               md.metric_key,
               md.label as metric_label,
               md.source_column,
               md.aggregation,
               md.unit,
               baseline_period.label as baseline_period_label,
               baseline_period.period_start as baseline_period_start,
               baseline_period.period_end as baseline_period_end,
               later_period.label as later_period_label,
               later_period.period_start as later_period_start,
               later_period.period_end as later_period_end
             from verified_business_outcomes o
             join verified_business_actions a
               on a.id = o.business_action_id
              and a.organization_id = o.organization_id
             join verified_metric_definitions md
               on md.id = o.metric_definition_id
              and md.organization_id = o.organization_id
             join reporting_periods baseline_period
               on baseline_period.id =
                 o.baseline_reporting_period_id
             join reporting_periods later_period
               on later_period.id =
                 o.later_reporting_period_id
             where o.organization_id = $1
             order by
               later_period.period_start desc,
               o.assessed_at desc,
               o.id desc`,
            [
              organizationId,
            ],
          );

        return result.rows
          .map(
            mapDetailedOutcome,
          );
      },
    );
  }
}

export class BusinessOutcomeError
  extends Error {
  constructor(
    message,
    code =
      "BUSINESS_OUTCOME_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "BusinessOutcomeError";

    this.code =
      code;
  }
}

function classifyOutcomeStatus({
  direction,
  metricPolarity,
}) {
  if (
    direction ===
    "flat"
  ) {
    return "unchanged";
  }

  if (
    metricPolarity ===
    "lower_is_better"
  ) {
    return direction ===
      "down"
      ? "improved"
      : "declined";
  }

  if (
    metricPolarity ===
    "higher_is_better"
  ) {
    return direction ===
      "up"
      ? "improved"
      : "declined";
  }

  return direction ===
    "up"
    ? "improved"
    : "declined";
}

async function selectActionContext({
  client,
  organizationId,
  actionId,
}) {
  const result =
    await client.query(
      `select
         a.id,
         a.organization_id,
         a.source_finding_id,
         a.title,
         a.status,
         a.completed_at,
         a.evidence as action_evidence,
         pf.evidence as finding_evidence,
         pf.metric_definition_id
       from verified_business_actions a
       join verified_performance_findings pf
         on pf.id = a.source_finding_id
        and pf.organization_id = a.organization_id
       where a.organization_id = $1
         and a.id = $2
       limit 1`,
      [
        organizationId,
        actionId,
      ],
    );

  return result.rows[0] ??
    null;
}

async function selectMetricPoint({
  client,
  organizationId,
  metricPointId,
}) {
  const result =
    await client.query(
      `select
         mp.*,
         rp.period_start,
         rp.period_end,
         rp.label as period_label
       from verified_metric_points mp
       join reporting_periods rp
         on rp.id = mp.reporting_period_id
       where mp.organization_id = $1
         and mp.id = $2
       limit 1`,
      [
        organizationId,
        metricPointId,
      ],
    );

  return result.rows[0] ??
    null;
}

async function selectLaterMetricPoints({
  client,
  organizationId,
  metricDefinitionId,
  baselinePeriodStart,
}) {
  const result =
    await client.query(
      `with ranked_points as (
         select
           mp.*,
           rp.period_start,
           rp.period_end,
           rp.label as period_label,
           row_number() over (
             partition by mp.reporting_period_id
             order by mp.created_at desc,
               mp.id desc
           ) as point_rank
         from verified_metric_points mp
         join reporting_periods rp
           on rp.id = mp.reporting_period_id
         where mp.organization_id = $1
           and mp.metric_definition_id = $2
           and rp.period_start > $3
       )
       select
         id,
         organization_id,
         metric_definition_id,
         data_stream_id,
         reporting_period_id,
         ingestion_run_id,
         raw_data_object_id,
         value_numeric,
         contributing_row_count,
         source_row_count,
         evidence,
         created_at,
         period_start,
         period_end,
         period_label,
         point_rank
       from ranked_points
       where point_rank = 1
       order by period_start asc,
         created_at asc,
         id asc`,
      [
        organizationId,
        metricDefinitionId,
        baselinePeriodStart,
      ],
    );

  return result.rows;
}

function buildOutcomeEvidence({
  action,
  baseline,
  later,
  change,
  status,
}) {
  return {
    kind:
      "verified_business_outcome",

    evidenceVersion:
      "deterministic-v1",

    assessment:
      "Later verified metric movement after the action baseline. This is not a causal claim.",

    causationClaimed:
      false,

    status,

    businessActionId:
      action.id,

    sourceFindingId:
      action.source_finding_id,

    metricDefinitionId:
      action.metric_definition_id,

    baselineMetricPointId:
      baseline.id,

    laterMetricPointId:
      later.id,

    baselineReportingPeriodId:
      baseline.reporting_period_id,

    laterReportingPeriodId:
      later.reporting_period_id,

    baselineRawDataObjectId:
      baseline.raw_data_object_id,

    laterRawDataObjectId:
      later.raw_data_object_id,

    baselineValue:
      change.previousValue,

    laterValue:
      change.currentValue,

    absoluteChange:
      change.absoluteChange,

    percentChange:
      change.percentChange,

    baselinePeriod: {
      label:
        baseline.period_label,

      periodStart:
        baseline.period_start,

      periodEnd:
        baseline.period_end,
    },

    laterPeriod: {
      label:
        later.period_label,

      periodStart:
        later.period_start,

      periodEnd:
        later.period_end,
    },

    actionEvidence:
      action.action_evidence ?? {},

    sourceFindingEvidence:
      action.finding_evidence ?? {},
  };
}

function mapOutcome(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    businessActionId:
      row.business_action_id,

    metricDefinitionId:
      row.metric_definition_id,

    baselineMetricPointId:
      row.baseline_metric_point_id,

    laterMetricPointId:
      row.later_metric_point_id,

    baselineReportingPeriodId:
      row.baseline_reporting_period_id,

    laterReportingPeriodId:
      row.later_reporting_period_id,

    status:
      row.status,

    baselineValue:
      normalizeDatabaseNumeric(
        row.baseline_value_numeric,
      ),

    laterValue:
      normalizeDatabaseNumeric(
        row.later_value_numeric,
      ),

    absoluteChange:
      normalizeDatabaseNumeric(
        row.absolute_change_numeric,
      ),

    percentChange:
      row.percent_change_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
            row.percent_change_numeric,
          ),

    evidence:
      row.evidence ?? {},

    assessedAt:
      row.assessed_at,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapDetailedOutcome(
  row,
) {
  return {
    ...mapOutcome(
      row,
    ),

    action: {
      id:
        row.business_action_id,

      title:
        row.action_title,

      status:
        row.action_status,
    },

    metric: {
      key:
        row.metric_key,

      label:
        row.metric_label,

      sourceColumn:
        row.source_column,

      aggregation:
        row.aggregation,

      unit:
        row.unit,
    },

    baselinePeriod: {
      id:
        row.baseline_reporting_period_id,

      label:
        row.baseline_period_label,

      periodStart:
        row.baseline_period_start,

      periodEnd:
        row.baseline_period_end,
    },

    laterPeriod: {
      id:
        row.later_reporting_period_id,

      label:
        row.later_period_label,

      periodStart:
        row.later_period_start,

      periodEnd:
        row.later_period_end,
    },
  };
}

async function requireWriteAccess({
  client,
  organizationId,
  actorUserId,
}) {
  await requireCapability({
    client,
    organizationId,
    actorUserId,
    capability:
      CAPABILITIES
        .WRITE_BUSINESS_DATA,
    message:
      "Capability required: business.write",
  });
}

async function requireReadAccess({
  client,
  organizationId,
  actorUserId,
}) {
  await requireCapability({
    client,
    organizationId,
    actorUserId,
    capability:
      CAPABILITIES
        .READ_BUSINESS_DATA,
    message:
      "Capability required: business.read",
  });
}

async function requireCapability({
  client,
  organizationId,
  actorUserId,
  capability,
  message,
}) {
  const result =
    await client.query(
      `select
         role
       from organization_memberships
       where organization_id = $1
         and user_id = $2
         and status = 'active'
       limit 1`,
      [
        organizationId,
        actorUserId,
      ],
    );

  const membership =
    result.rows[0];

  if (!membership) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  const capabilities =
    ROLE_CAPABILITIES[
      membership.role
    ] ?? [];

  if (
    !capabilities.includes(
      capability,
    )
  ) {
    throw new AuthError(
      message,
      "CAPABILITY_DENIED",
    );
  }
}

function validateIdentifier(
  value,
  message,
) {
  if (
    typeof value !==
      "string" ||
    !value.trim()
  ) {
    throw new BusinessOutcomeError(
      message,
      "BUSINESS_OUTCOME_INVALID",
    );
  }
}

function normalizeDatabaseNumeric(
  value,
) {
  let text =
    String(
      value ?? "0",
    );

  if (
    text.includes(
      ".",
    )
  ) {
    text =
      text.replace(
        /0+$/,
        "",
      );

    text =
      text.replace(
        /\.$/,
        "",
      );
  }

  return text ===
    "-0"
    ? "0"
    : text;
}
