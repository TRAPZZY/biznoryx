import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const DECIMAL_SCALE =
  10;

const DECIMAL_FACTOR =
  10n **
  BigInt(
    DECIMAL_SCALE,
  );

export class PostgresMetricComparisonRepository {
  constructor(
    pool,
  ) {
    if (
      !pool
    ) {
      throw new TypeError(
        "PostgreSQL pool is required.",
      );
    }

    this.pool =
      pool;
  }

  /*
   * Rebuild every comparison belonging to the
   * metric definitions touched by one ingestion.
   *
   * Rebuilding the complete history for the
   * affected definitions keeps the comparison
   * chain correct even when the same ingestion
   * run is retried and its verified points are
   * replaced idempotently.
   */
  async refreshForIngestion({
    organizationId,
    ingestionRunId,
  }) {
    validateIdentifier(
      organizationId,
      "Organization is required.",
    );

    validateIdentifier(
      ingestionRunId,
      "Ingestion run is required.",
    );

    const client =
      await this.pool.connect();

    try {
      await client.query(
        "begin",
      );

      await setTenantContext({
        client,
        organizationId,
      });

      const touchedResult =
        await client.query(
          `select distinct
             metric_definition_id
           from verified_metric_points
           where organization_id = $1
             and ingestion_run_id = $2
           order by metric_definition_id`,
          [
            organizationId,
            ingestionRunId,
          ],
        );

      const comparisons =
        [];

      for (
        const touched of
          touchedResult.rows
      ) {
        const metricDefinitionId =
          touched
            .metric_definition_id;

        const definitionResult =
          await client.query(
            `select
               id,
               metric_key,
               label,
               source_column,
               aggregation,
               unit
             from verified_metric_definitions
             where organization_id = $1
               and id = $2
             limit 1`,
            [
              organizationId,
              metricDefinitionId,
            ],
          );

        const definition =
          definitionResult
            .rows[0];

        if (
          !definition
        ) {
          throw new MetricComparisonError(
            "Verified metric definition was not found.",
            "METRIC_DEFINITION_MISSING",
          );
        }

        /*
         * If more than one ingestion exists for
         * the same metric and reporting period,
         * only the latest verified point for that
         * period participates in the trend chain.
         */
        const pointsResult =
          await client.query(
            `with ranked_points as (
               select
                 mp.id,
                 mp.metric_definition_id,
                 mp.reporting_period_id,
                 mp.ingestion_run_id,
                 mp.raw_data_object_id,
                 mp.value_numeric,
                 mp.contributing_row_count,
                 mp.source_row_count,
                 mp.evidence,
                 mp.created_at,

                 rp.period_start,
                 rp.period_end,
                 rp.label as period_label,

                 row_number() over (
                   partition by
                     mp.metric_definition_id,
                     mp.reporting_period_id
                   order by
                     mp.created_at desc,
                     mp.id desc
                 ) as point_rank

               from verified_metric_points mp

               join reporting_periods rp
                 on rp.id =
                   mp.reporting_period_id

               where mp.organization_id = $1
                 and mp.metric_definition_id = $2
             )

             select
               id,
               metric_definition_id,
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
               period_label

             from ranked_points

             where point_rank = 1

             order by
               period_start asc,
               created_at asc,
               id asc`,
            [
              organizationId,
              metricDefinitionId,
            ],
          );

        await client.query(
          `delete from verified_metric_comparisons
           where organization_id = $1
             and metric_definition_id = $2`,
          [
            organizationId,
            metricDefinitionId,
          ],
        );

        let previous =
          null;

        for (
          const current of
            pointsResult.rows
        ) {
          const comparison =
            previous
              ? buildReadyComparison({
                  organizationId,
                  definition,
                  previous,
                  current,
                })
              : buildNotReadyComparison({
                  organizationId,
                  definition,
                  current,
                });

          const persisted =
            await persistComparison({
              client,
              comparison,
            });

          comparisons.push(
            persisted,
          );

          previous =
            current;
        }
      }

      await client.query(
        "commit",
      );

      return comparisons;
    } catch (error) {
      await safeRollback(
        client,
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async listTrendRows({
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
            `with ranked_comparisons as (
               select
                 c.id,
                 c.organization_id,
                 c.metric_definition_id,

                 c.current_metric_point_id,
                 c.previous_metric_point_id,

                 c.current_reporting_period_id,
                 c.previous_reporting_period_id,

                 c.status,
                 c.direction,

                 c.previous_value_numeric,
                 c.current_value_numeric,
                 c.absolute_change_numeric,
                 c.percent_change_numeric,

                 c.evidence,
                 c.created_at,
                 c.updated_at,

                 md.metric_key,
                 md.label as metric_label,
                 md.source_column,
                 md.aggregation,
                 md.unit,

                 ds.id as data_stream_id,
                 ds.name as data_stream_name,
                 ds.display_name as data_stream_display_name,

                 current_period.period_start
                   as current_period_start,

                 current_period.period_end
                   as current_period_end,

                 current_period.label
                   as current_period_label,

                 previous_period.period_start
                   as previous_period_start,

                 previous_period.period_end
                   as previous_period_end,

                 previous_period.label
                   as previous_period_label,

                 row_number() over (
                   partition by
                     c.metric_definition_id
                   order by
                     current_period.period_start desc,
                     c.updated_at desc,
                     c.id desc
                 ) as comparison_rank

               from verified_metric_comparisons c

               join verified_metric_definitions md
                 on md.id =
                   c.metric_definition_id
                and md.organization_id =
                   c.organization_id

               join data_streams ds
                 on ds.id =
                   md.data_stream_id

               join reporting_periods current_period
                 on current_period.id =
                   c.current_reporting_period_id

               left join reporting_periods previous_period
                 on previous_period.id =
                   c.previous_reporting_period_id

               where c.organization_id = $1
             )

             select
               id,
               organization_id,
               metric_definition_id,
               current_metric_point_id,
               previous_metric_point_id,
               current_reporting_period_id,
               previous_reporting_period_id,
               status,
               direction,
               previous_value_numeric,
               current_value_numeric,
               absolute_change_numeric,
               percent_change_numeric,
               evidence,
               created_at,
               updated_at,
               metric_key,
               metric_label,
               source_column,
               aggregation,
               unit,
               data_stream_id,
               data_stream_name,
               data_stream_display_name,
               current_period_start,
               current_period_end,
               current_period_label,
               previous_period_start,
               previous_period_end,
               previous_period_label,
               comparison_rank
             from ranked_comparisons
             where comparison_rank = 1
             order by
               data_stream_display_name asc,
               metric_label asc`,
            [
              organizationId,
            ],
          );

        return result.rows
          .map(
            mapTrendRow,
          );
      },
    );
  }

  async listHistory({
    organizationId,
    actorUserId,
    metricDefinitionId,
  }) {
    validateIdentifier(
      metricDefinitionId,
      "Metric definition is required.",
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
        await requireReadAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `select
               c.id,
               c.organization_id,
               c.metric_definition_id,

               c.current_metric_point_id,
               c.previous_metric_point_id,

               c.current_reporting_period_id,
               c.previous_reporting_period_id,

               c.status,
               c.direction,

               c.previous_value_numeric,
               c.current_value_numeric,
               c.absolute_change_numeric,
               c.percent_change_numeric,

               c.evidence,
               c.created_at,
               c.updated_at,

               md.metric_key,
               md.label as metric_label,
               md.source_column,
               md.aggregation,
               md.unit,

               ds.id as data_stream_id,
               ds.name as data_stream_name,
               ds.display_name as data_stream_display_name,

               current_period.period_start
                 as current_period_start,

               current_period.period_end
                 as current_period_end,

               current_period.label
                 as current_period_label,

               previous_period.period_start
                 as previous_period_start,

               previous_period.period_end
                 as previous_period_end,

               previous_period.label
                 as previous_period_label

             from verified_metric_comparisons c

             join verified_metric_definitions md
               on md.id =
                 c.metric_definition_id
              and md.organization_id =
                 c.organization_id

             join data_streams ds
               on ds.id =
                 md.data_stream_id

             join reporting_periods current_period
               on current_period.id =
                 c.current_reporting_period_id

             left join reporting_periods previous_period
               on previous_period.id =
                 c.previous_reporting_period_id

             where c.organization_id = $1
               and c.metric_definition_id = $2

             order by
               current_period.period_start asc,
               c.updated_at asc,
               c.id asc`,
            [
              organizationId,
              metricDefinitionId,
            ],
          );

        return result.rows
          .map(
            mapTrendRow,
          );
      },
    );
  }
}

export class MetricComparisonError
  extends Error {
  constructor(
    message,
    code =
      "METRIC_COMPARISON_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "MetricComparisonError";

    this.code =
      code;
  }
}

export function calculateMetricChange({
  previousValue,
  currentValue,
}) {
  const previous =
    decimalToScaledInteger(
      previousValue,
    );

  const current =
    decimalToScaledInteger(
      currentValue,
    );

  const difference =
    current -
    previous;

  let direction;

  if (
    difference >
    0n
  ) {
    direction =
      "up";
  } else if (
    difference <
    0n
  ) {
    direction =
      "down";
  } else {
    direction =
      "flat";
  }

  const absoluteChange =
    scaledIntegerToDecimal(
      difference,
    );

  let percentChange =
    null;

  if (
    previous !==
    0n
  ) {
    const numerator =
      difference *
      100n *
      DECIMAL_FACTOR;

    const denominator =
      previous <
      0n
        ? -previous
        : previous;

    percentChange =
      scaledIntegerToDecimal(
        divideRounded(
          numerator,
          denominator,
        ),
      );
  }

  return {
    previousValue:
      scaledIntegerToDecimal(
        previous,
      ),

    currentValue:
      scaledIntegerToDecimal(
        current,
      ),

    absoluteChange,

    percentChange,

    direction,
  };
}

function buildNotReadyComparison({
  organizationId,
  definition,
  current,
}) {
  return {
    organizationId,

    metricDefinitionId:
      definition.id,

    currentMetricPointId:
      current.id,

    previousMetricPointId:
      null,

    currentReportingPeriodId:
      current.reporting_period_id,

    previousReportingPeriodId:
      null,

    status:
      "not_ready",

    direction:
      "not_ready",

    previousValue:
      null,

    currentValue:
      normalizeDatabaseNumeric(
        current.value_numeric,
      ),

    absoluteChange:
      null,

    percentChange:
      null,

    evidence: {
      kind:
        "verified_metric_comparison",

      status:
        "not_ready",

      reason:
        "A previous verified period is required.",

      metricDefinitionId:
        definition.id,

      metricKey:
        definition.metric_key,

      currentMetricPointId:
        current.id,

      currentIngestionRunId:
        current.ingestion_run_id,

      currentRawDataObjectId:
        current.raw_data_object_id,

      currentReportingPeriodId:
        current.reporting_period_id,

      currentValue:
        normalizeDatabaseNumeric(
          current.value_numeric,
        ),
    },
  };
}

function buildReadyComparison({
  organizationId,
  definition,
  previous,
  current,
}) {
  const change =
    calculateMetricChange({
      previousValue:
        previous.value_numeric,

      currentValue:
        current.value_numeric,
    });

  return {
    organizationId,

    metricDefinitionId:
      definition.id,

    currentMetricPointId:
      current.id,

    previousMetricPointId:
      previous.id,

    currentReportingPeriodId:
      current.reporting_period_id,

    previousReportingPeriodId:
      previous.reporting_period_id,

    status:
      "ready",

    direction:
      change.direction,

    previousValue:
      change.previousValue,

    currentValue:
      change.currentValue,

    absoluteChange:
      change.absoluteChange,

    percentChange:
      change.percentChange,

    evidence: {
      kind:
        "verified_metric_comparison",

      status:
        "ready",

      metricDefinitionId:
        definition.id,

      metricKey:
        definition.metric_key,

      sourceColumn:
        definition.source_column,

      aggregation:
        definition.aggregation,

      previousMetricPointId:
        previous.id,

      currentMetricPointId:
        current.id,

      previousIngestionRunId:
        previous.ingestion_run_id,

      currentIngestionRunId:
        current.ingestion_run_id,

      previousRawDataObjectId:
        previous.raw_data_object_id,

      currentRawDataObjectId:
        current.raw_data_object_id,

      previousReportingPeriodId:
        previous.reporting_period_id,

      currentReportingPeriodId:
        current.reporting_period_id,

      previousValue:
        change.previousValue,

      currentValue:
        change.currentValue,

      absoluteChange:
        change.absoluteChange,

      percentChange:
        change.percentChange,

      absoluteCalculation:
        "current - previous",

      percentCalculation:
        change.percentChange ===
          null
          ? null
          : "((current - previous) / abs(previous)) * 100",
    },
  };
}

async function persistComparison({
  client,
  comparison,
}) {
  const result =
    await client.query(
      `insert into verified_metric_comparisons (
         organization_id,
         metric_definition_id,

         current_metric_point_id,
         previous_metric_point_id,

         current_reporting_period_id,
         previous_reporting_period_id,

         status,
         direction,

         previous_value_numeric,
         current_value_numeric,
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
       returning
         id,
         organization_id,
         metric_definition_id,

         current_metric_point_id,
         previous_metric_point_id,

         current_reporting_period_id,
         previous_reporting_period_id,

         status,
         direction,

         previous_value_numeric,
         current_value_numeric,
         absolute_change_numeric,
         percent_change_numeric,

         evidence,
         created_at,
         updated_at`,
      [
        comparison
          .organizationId,

        comparison
          .metricDefinitionId,

        comparison
          .currentMetricPointId,

        comparison
          .previousMetricPointId,

        comparison
          .currentReportingPeriodId,

        comparison
          .previousReportingPeriodId,

        comparison.status,

        comparison.direction,

        comparison
          .previousValue,

        comparison
          .currentValue,

        comparison
          .absoluteChange,

        comparison
          .percentChange,

        JSON.stringify(
          comparison.evidence,
        ),
      ],
    );

  return mapComparison(
    result.rows[0],
  );
}

function mapComparison(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    metricDefinitionId:
      row.metric_definition_id,

    currentMetricPointId:
      row.current_metric_point_id,

    previousMetricPointId:
      row.previous_metric_point_id,

    currentReportingPeriodId:
      row.current_reporting_period_id,

    previousReportingPeriodId:
      row.previous_reporting_period_id,

    status:
      row.status,

    direction:
      row.direction,

    previousValue:
      row.previous_value_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
            row.previous_value_numeric,
          ),

    currentValue:
      normalizeDatabaseNumeric(
        row.current_value_numeric,
      ),

    absoluteChange:
      row.absolute_change_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
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
      row.evidence ??
      {},

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapTrendRow(
  row,
) {
  return {
    id:
      row.id,

    metricDefinitionId:
      row.metric_definition_id,

    metricKey:
      row.metric_key,

    label:
      row.metric_label,

    sourceColumn:
      row.source_column,

    aggregation:
      row.aggregation,

    unit:
      row.unit,

    status:
      row.status,

    direction:
      row.direction,

    previousValue:
      row.previous_value_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
            row.previous_value_numeric,
          ),

    currentValue:
      normalizeDatabaseNumeric(
        row.current_value_numeric,
      ),

    absoluteChange:
      row.absolute_change_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
            row.absolute_change_numeric,
          ),

    percentChange:
      row.percent_change_numeric ===
        null
        ? null
        : normalizeDatabaseNumeric(
            row.percent_change_numeric,
          ),

    previousMetricPointId:
      row.previous_metric_point_id,

    currentMetricPointId:
      row.current_metric_point_id,

    previousPeriod:
      row.previous_reporting_period_id
        ? {
            id:
              row.previous_reporting_period_id,

            periodStart:
              row.previous_period_start,

            periodEnd:
              row.previous_period_end,

            label:
              row.previous_period_label,
          }
        : null,

    currentPeriod: {
      id:
        row.current_reporting_period_id,

      periodStart:
        row.current_period_start,

      periodEnd:
        row.current_period_end,

      label:
        row.current_period_label,
    },

    dataStream: {
      id:
        row.data_stream_id,

      name:
        row.data_stream_name,

      displayName:
        row.data_stream_display_name,
    },

    evidence:
      row.evidence ??
      {},

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function decimalToScaledInteger(
  value,
) {
  const text =
    String(
      value ??
        "",
    ).trim();

  const match =
    /^([+-]?)(\d+)(?:\.(\d{0,10}))?$/.exec(
      text,
    );

  if (
    !match
  ) {
    throw new MetricComparisonError(
      "Metric comparison value is invalid.",
      "METRIC_VALUE_INVALID",
    );
  }

  const sign =
    match[1] ===
    "-"
      ? -1n
      : 1n;

  const integerPart =
    match[2];

  const fractionalPart =
    (
      match[3] ??
      ""
    ).padEnd(
      DECIMAL_SCALE,
      "0",
    );

  return (
    BigInt(
      integerPart,
    ) *
      DECIMAL_FACTOR +
    BigInt(
      fractionalPart ||
        "0",
    )
  ) * sign;
}

function scaledIntegerToDecimal(
  value,
) {
  const negative =
    value <
    0n;

  const absolute =
    negative
      ? -value
      : value;

  const integerPart =
    absolute /
    DECIMAL_FACTOR;

  const fractionalPart =
    (
      absolute %
      DECIMAL_FACTOR
    )
      .toString()
      .padStart(
        DECIMAL_SCALE,
        "0",
      )
      .replace(
        /0+$/,
        "",
      );

  const text =
    fractionalPart
      ? `${integerPart}.${fractionalPart}`
      : integerPart.toString();

  return negative &&
    absolute !==
      0n
    ? `-${text}`
    : text;
}

function divideRounded(
  numerator,
  denominator,
) {
  if (
    denominator <=
    0n
  ) {
    throw new MetricComparisonError(
      "Metric percentage denominator is invalid.",
      "METRIC_PERCENT_DENOMINATOR_INVALID",
    );
  }

  const negative =
    numerator <
    0n;

  const absoluteNumerator =
    negative
      ? -numerator
      : numerator;

  const quotient =
    absoluteNumerator /
    denominator;

  const remainder =
    absoluteNumerator %
    denominator;

  const rounded =
    remainder *
      2n >=
    denominator
      ? quotient +
        1n
      : quotient;

  return negative
    ? -rounded
    : rounded;
}

function normalizeDatabaseNumeric(
  value,
) {
  let text =
    String(
      value ??
        "0",
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

async function requireReadAccess({
  client,
  organizationId,
  actorUserId,
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

  if (
    !membership
  ) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  const capabilities =
    ROLE_CAPABILITIES[
      membership.role
    ] ??
    [];

  if (
    !capabilities.includes(
      CAPABILITIES.READ_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.read",
      "CAPABILITY_DENIED",
    );
  }
}

async function setTenantContext({
  client,
  organizationId,
}) {
  await client.query(
    `select set_config(
       'app.current_organization_id',
       $1,
       true
     )`,
    [
      organizationId,
    ],
  );
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
    throw new MetricComparisonError(
      message,
      "METRIC_COMPARISON_INVALID",
    );
  }
}

async function safeRollback(
  client,
) {
  try {
    await client.query(
      "rollback",
    );
  } catch {
    /*
     * Preserve the original error.
     */
  }
}
