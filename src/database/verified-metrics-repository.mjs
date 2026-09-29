import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const ALLOWED_AGGREGATIONS =
  new Set([
    "sum",
    "count",
    "average",
    "min",
    "max",
  ]);

export class PostgresVerifiedMetricsRepository {
  constructor(pool) {
    if (!pool) {
      throw new TypeError(
        "PostgreSQL pool is required.",
      );
    }

    this.pool =
      pool;
  }

  async replaceIngestionMetrics({
    organizationId,
    ingestionRunId,
    metrics,
  }) {
    validateIdentifier(
      organizationId,
      "Organization is required.",
    );

    validateIdentifier(
      ingestionRunId,
      "Ingestion run is required.",
    );

    if (
      !Array.isArray(
        metrics,
      )
    ) {
      throw new VerifiedMetricError(
        "Metrics must be an array.",
        "VERIFIED_METRICS_INVALID",
      );
    }

    const normalizedMetrics =
      metrics.map(
        normalizeMetric,
      );

    ensureUniqueMetricKeys(
      normalizedMetrics,
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

      const contextResult =
        await client.query(
          `select
             ir.id as ingestion_run_id,
             ir.organization_id,
             ir.data_stream_id,
             ir.reporting_period_id,
             ir.raw_data_object_id,
             ir.schema_version_id,
             ir.status as ingestion_status,
             ir.row_count,

             rdo.checksum_sha256,

             ds.name as data_stream_name,
             ds.display_name as data_stream_display_name,

             ssv.columns as schema_columns

           from ingestion_runs ir

           join raw_data_objects rdo
             on rdo.id =
               ir.raw_data_object_id

           join data_streams ds
             on ds.id =
               ir.data_stream_id

           left join stream_schema_versions ssv
             on ssv.id =
               ir.schema_version_id

           where ir.id = $1
             and ir.organization_id = $2

           limit 1`,
          [
            ingestionRunId,
            organizationId,
          ],
        );

      const context =
        contextResult.rows[0];

      if (!context) {
        throw new VerifiedMetricError(
          "Ingestion run was not found.",
          "INGESTION_CONTEXT_MISSING",
        );
      }

      if (
        context.ingestion_status !==
        "validated"
      ) {
        throw new VerifiedMetricError(
          "Only validated ingestion runs can produce verified metrics.",
          "INGESTION_NOT_VERIFIED",
        );
      }

      const schemaColumns =
        normalizeSchemaColumns(
          context.schema_columns,
        );

      for (
        const metric of normalizedMetrics
      ) {
        if (
          schemaColumns.size > 0 &&
          !schemaColumns.has(
            metric.sourceColumn
              .toLowerCase(),
          )
        ) {
          throw new VerifiedMetricError(
            `Metric source column "${metric.sourceColumn}" is not present in the verified ingestion schema.`,
            "METRIC_SOURCE_COLUMN_INVALID",
          );
        }
      }

      /*
       * Retrying the same ingestion run is
       * idempotent. Existing metric points
       * for the run are replaced atomically.
       */
      await client.query(
        `delete from verified_metric_points
         where organization_id = $1
           and ingestion_run_id = $2`,
        [
          organizationId,
          ingestionRunId,
        ],
      );

      const persisted =
        [];

      for (
        const metric of normalizedMetrics
      ) {
        const definitionResult =
          await client.query(
            `insert into verified_metric_definitions (
               organization_id,
               data_stream_id,
               metric_key,
               label,
               source_column,
               aggregation,
               unit
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7
             )
             on conflict (
               organization_id,
               data_stream_id,
               metric_key
             )
             do update set
               label = excluded.label,
               unit = excluded.unit,
               updated_at = now()
             returning
               id,
               organization_id,
               data_stream_id,
               metric_key,
               label,
               source_column,
               aggregation,
               unit,
               created_at,
               updated_at`,
            [
              organizationId,

              context.data_stream_id,

              metric.metricKey,

              metric.label,

              metric.sourceColumn,

              metric.aggregation,

              metric.unit,
            ],
          );

        const definition =
          definitionResult.rows[0];

        if (
          definition.source_column !==
            metric.sourceColumn ||
          definition.aggregation !==
            metric.aggregation
        ) {
          throw new VerifiedMetricError(
            `Metric key "${metric.metricKey}" is already bound to a different calculation.`,
            "METRIC_DEFINITION_CONFLICT",
          );
        }

        const evidence = {
          ...metric.evidence,

          calculation:
            `${metric.aggregation}(${metric.sourceColumn})`,

          organizationId,

          ingestionRunId,

          rawDataObjectId:
            context.raw_data_object_id,

          checksumSha256:
            context.checksum_sha256,

          dataStreamId:
            context.data_stream_id,

          reportingPeriodId:
            context.reporting_period_id,

          sourceColumn:
            metric.sourceColumn,

          aggregation:
            metric.aggregation,

          sourceRowCount:
            metric.sourceRowCount,

          contributingRowCount:
            metric.contributingRowCount,
        };

        const pointResult =
          await client.query(
            `insert into verified_metric_points (
               organization_id,
               metric_definition_id,
               data_stream_id,
               reporting_period_id,
               ingestion_run_id,
               raw_data_object_id,
               value_numeric,
               contributing_row_count,
               source_row_count,
               evidence
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7::numeric,
               $8,
               $9,
               $10::jsonb
             )
             returning
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
               created_at`,
            [
              organizationId,

              definition.id,

              context.data_stream_id,

              context.reporting_period_id,

              ingestionRunId,

              context.raw_data_object_id,

              metric.value,

              metric.contributingRowCount,

              metric.sourceRowCount,

              JSON.stringify(
                evidence,
              ),
            ],
          );

        persisted.push({
          definition:
            mapDefinition(
              definition,
            ),

          point:
            mapPoint(
              pointResult.rows[0],
            ),
        });
      }

      await client.query(
        "commit",
      );

      return persisted;
    } catch (error) {
      await safeRollback(
        client,
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async listSeries({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireReadAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `with ranked_points as (
               select
                 md.id as metric_definition_id,
                 md.metric_key,
                 md.label as metric_label,
                 md.source_column,
                 md.aggregation,
                 md.unit,

                 ds.id as data_stream_id,
                 ds.name as data_stream_name,
                 ds.display_name as data_stream_display_name,

                 mp.id as metric_point_id,
                 mp.ingestion_run_id,
                 mp.raw_data_object_id,
                 mp.value_numeric,
                 mp.contributing_row_count,
                 mp.source_row_count,
                 mp.evidence,
                 mp.created_at as metric_point_created_at,

                 rp.id as reporting_period_id,
                 rp.period_start,
                 rp.period_end,
                 rp.label as reporting_period_label,

                 row_number() over (
                   partition by
                     md.id,
                     rp.id
                   order by
                     mp.created_at desc,
                     mp.id desc
                 ) as point_rank

               from verified_metric_definitions md

               join verified_metric_points mp
                 on mp.metric_definition_id =
                   md.id
                and mp.organization_id =
                   md.organization_id

               join data_streams ds
                 on ds.id =
                   md.data_stream_id

               join reporting_periods rp
                 on rp.id =
                   mp.reporting_period_id

               where md.organization_id = $1
             )

             select
               metric_definition_id,
               metric_key,
               metric_label,
               source_column,
               aggregation,
               unit,

               data_stream_id,
               data_stream_name,
               data_stream_display_name,

               metric_point_id,
               ingestion_run_id,
               raw_data_object_id,
               value_numeric,
               contributing_row_count,
               source_row_count,
               evidence,
               metric_point_created_at,

               reporting_period_id,
               period_start,
               period_end,
               reporting_period_label

             from ranked_points

             where point_rank = 1

             order by
               data_stream_display_name asc,
               metric_label asc,
               period_start asc,
               metric_point_created_at asc`,
            [
              organizationId,
            ],
          );

        return buildSeries(
          result.rows,
        );
      },
    );
  }

  async listSeriesGroups({
    organizationId,
    actorUserId,
  }) {
    const series =
      await this.listSeries({
        organizationId,
        actorUserId,
      });

    const groups =
      new Map();

    for (
      const item of series
    ) {
      const streamId =
        item.dataStream.id;

      let group =
        groups.get(
          streamId,
        );

      if (!group) {
        group = {
          id:
            streamId,

          name:
            item.dataStream.name,

          displayName:
            item.dataStream.displayName,

          seriesIds:
            [],
        };

        groups.set(
          streamId,
          group,
        );
      }

      group.seriesIds.push(
        item.id,
      );
    }

    return [
      ...groups.values(),
    ];
  }
}

export class VerifiedMetricError
  extends Error {
  constructor(
    message,
    code =
      "VERIFIED_METRIC_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "VerifiedMetricError";

    this.code =
      code;
  }
}

function normalizeMetric(
  metric,
) {
  if (
    !metric ||
    typeof metric !==
      "object" ||
    Array.isArray(
      metric,
    )
  ) {
    throw new VerifiedMetricError(
      "Metric definition is invalid.",
      "VERIFIED_METRICS_INVALID",
    );
  }

  const sourceColumn =
    cleanText(
      metric.sourceColumn,
      "Metric source column is required.",
      160,
    );

  const aggregation =
    cleanText(
      metric.aggregation,
      "Metric aggregation is required.",
      32,
    ).toLowerCase();

  if (
    !ALLOWED_AGGREGATIONS.has(
      aggregation,
    )
  ) {
    throw new VerifiedMetricError(
      "Metric aggregation is not supported.",
      "METRIC_AGGREGATION_INVALID",
    );
  }

  const metricKey =
    cleanText(
      metric.metricKey ??
        `${aggregation}:${sourceColumn.toLowerCase()}`,
      "Metric key is required.",
      180,
    );

  const label =
    cleanText(
      metric.label ??
        humanizeColumn(
          sourceColumn,
        ),
      "Metric label is required.",
      160,
    );

  const value =
    normalizeNumericInput(
      metric.value,
    );

  const sourceRowCount =
    normalizeCount(
      metric.sourceRowCount,
      "Metric source row count is invalid.",
    );

  const contributingRowCount =
    normalizeCount(
      metric.contributingRowCount,
      "Metric contributing row count is invalid.",
    );

  if (
    contributingRowCount >
    sourceRowCount
  ) {
    throw new VerifiedMetricError(
      "Metric contributing rows cannot exceed source rows.",
      "METRIC_ROW_COUNT_INVALID",
    );
  }

  const unit =
    metric.unit ===
      undefined ||
    metric.unit ===
      null ||
    String(
      metric.unit,
    ).trim() ===
      ""
      ? null
      : cleanText(
          metric.unit,
          "Metric unit is invalid.",
          40,
        );

  const evidence =
    metric.evidence ===
      undefined
      ? {}
      : metric.evidence;

  if (
    !evidence ||
    typeof evidence !==
      "object" ||
    Array.isArray(
      evidence,
    )
  ) {
    throw new VerifiedMetricError(
      "Metric evidence must be an object.",
      "METRIC_EVIDENCE_INVALID",
    );
  }

  return {
    metricKey,
    label,
    sourceColumn,
    aggregation,
    value,
    sourceRowCount,
    contributingRowCount,
    unit,
    evidence,
  };
}

function ensureUniqueMetricKeys(
  metrics,
) {
  const keys =
    new Set();

  for (
    const metric of metrics
  ) {
    const key =
      metric.metricKey
        .toLowerCase();

    if (
      keys.has(
        key,
      )
    ) {
      throw new VerifiedMetricError(
        `Metric key "${metric.metricKey}" is duplicated in the same ingestion result.`,
        "METRIC_KEY_DUPLICATE",
      );
    }

    keys.add(
      key,
    );
  }
}

function normalizeSchemaColumns(
  columns,
) {
  if (
    !Array.isArray(
      columns,
    )
  ) {
    return new Set();
  }

  return new Set(
    columns
      .map(
        (column) =>
          String(
            column?.name ??
              "",
          )
            .trim()
            .toLowerCase(),
      )
      .filter(
        Boolean,
      ),
  );
}

function normalizeNumericInput(
  value,
) {
  const text =
    String(
      value ?? "",
    ).trim();

  if (
    !/^-?\d+(?:\.\d+)?$/.test(
      text,
    )
  ) {
    throw new VerifiedMetricError(
      "Metric value must be numeric.",
      "METRIC_VALUE_INVALID",
    );
  }

  const unsigned =
    text.replace(
      /^-/,
      "",
    );

  const [
    integerPart,
    fractionalPart = "",
  ] =
    unsigned.split(
      ".",
    );

  const integerDigits =
    integerPart.replace(
      /^0+/,
      "",
    ).length || 1;

  if (
    integerDigits +
      fractionalPart.length >
      38 ||
    fractionalPart.length >
      10
  ) {
    throw new VerifiedMetricError(
      "Metric value exceeds supported precision.",
      "METRIC_VALUE_INVALID",
    );
  }

  return text;
}

function normalizeCount(
  value,
  message,
) {
  const number =
    Number(
      value,
    );

  if (
    !Number.isInteger(
      number,
    ) ||
    number < 0
  ) {
    throw new VerifiedMetricError(
      message,
      "METRIC_ROW_COUNT_INVALID",
    );
  }

  return number;
}

function buildSeries(
  rows,
) {
  const series =
    new Map();

  for (
    const row of rows
  ) {
    let item =
      series.get(
        row.metric_definition_id,
      );

    if (!item) {
      item = {
        id:
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

        dataStream: {
          id:
            row.data_stream_id,

          name:
            row.data_stream_name,

          displayName:
            row.data_stream_display_name,
        },

        points:
          [],
      };

      series.set(
        row.metric_definition_id,
        item,
      );
    }

    item.points.push({
      id:
        row.metric_point_id,

      ingestionRunId:
        row.ingestion_run_id,

      rawDataObjectId:
        row.raw_data_object_id,

      reportingPeriodId:
        row.reporting_period_id,

      periodStart:
        row.period_start,

      periodEnd:
        row.period_end,

      periodLabel:
        row.reporting_period_label,

      value:
        normalizeDatabaseNumeric(
          row.value_numeric,
        ),

      contributingRowCount:
        Number(
          row.contributing_row_count,
        ),

      sourceRowCount:
        Number(
          row.source_row_count,
        ),

      evidence:
        row.evidence ?? {},

      createdAt:
        row.metric_point_created_at,
    });
  }

  return [
    ...series.values(),
  ];
}

function mapDefinition(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    dataStreamId:
      row.data_stream_id,

    metricKey:
      row.metric_key,

    label:
      row.label,

    sourceColumn:
      row.source_column,

    aggregation:
      row.aggregation,

    unit:
      row.unit,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapPoint(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    metricDefinitionId:
      row.metric_definition_id,

    dataStreamId:
      row.data_stream_id,

    reportingPeriodId:
      row.reporting_period_id,

    ingestionRunId:
      row.ingestion_run_id,

    rawDataObjectId:
      row.raw_data_object_id,

    value:
      normalizeDatabaseNumeric(
        row.value_numeric,
      ),

    contributingRowCount:
      Number(
        row.contributing_row_count,
      ),

    sourceRowCount:
      Number(
        row.source_row_count,
      ),

    evidence:
      row.evidence ?? {},

    createdAt:
      row.created_at,
  };
}

async function requireReadAccess({
  client,
  organizationId,
  actorUserId,
}) {
  const role =
    await membershipRole({
      client,
      organizationId,
      actorUserId,
    });

  const capabilities =
    ROLE_CAPABILITIES[
      role
    ] ?? [];

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

async function membershipRole({
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

  if (!membership) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  return membership.role;
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
    throw new VerifiedMetricError(
      message,
      "VERIFIED_METRICS_INVALID",
    );
  }
}

function cleanText(
  value,
  message,
  maximumLength,
) {
  const text =
    String(
      value ?? "",
    ).trim();

  if (
    !text ||
    text.length >
      maximumLength
  ) {
    throw new VerifiedMetricError(
      message,
      "VERIFIED_METRICS_INVALID",
    );
  }

  return text;
}

function humanizeColumn(
  column,
) {
  return String(
    column,
  )
    .replace(
      /[_-]+/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim()
    .replace(
      /\b\w/g,
      (character) =>
        character.toUpperCase(),
    );
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

  if (
    text ===
    "-0"
  ) {
    return "0";
  }

  return text;
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
     * Preserve the original failure.
     */
  }
}