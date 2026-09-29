import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const HIGHER_IS_BETTER =
  new Set([
    "revenue",
    "sales",
    "profit",
    "gross_profit",
    "net_profit",
    "net_income",
    "orders",
    "customers",
    "conversions",
  ]);

const LOWER_IS_BETTER =
  new Set([
    "cost",
    "costs",
    "expense",
    "expenses",
    "refund",
    "refunds",
    "churn",
    "defect",
    "defects",
    "downtime",
    "return",
    "returns",
    "chargeback",
    "chargebacks",
  ]);

export class PostgresPerformanceFindingsRepository {
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

      const comparisonResult =
        await client.query(
          `select
             c.id as comparison_id,
             c.organization_id,
             c.metric_definition_id,

             c.current_metric_point_id,
             c.previous_metric_point_id,

             c.current_reporting_period_id,
             c.previous_reporting_period_id,

             c.status as comparison_status,
             c.direction,

             c.previous_value_numeric,
             c.current_value_numeric,
             c.absolute_change_numeric,
             c.percent_change_numeric,

             c.evidence as comparison_evidence,

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

           join verified_metric_points current_point
             on current_point.id =
               c.current_metric_point_id
            and current_point.organization_id =
               c.organization_id

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
             and current_point.ingestion_run_id = $2

           order by
             md.metric_key asc`,
          [
            organizationId,
            ingestionRunId,
          ],
        );

      const persisted =
        [];

      for (
        const comparison of
          comparisonResult.rows
      ) {
        if (
          comparison
            .comparison_status !==
          "ready"
        ) {
          await client.query(
            `delete from verified_performance_findings
             where organization_id = $1
               and metric_definition_id = $2
               and current_reporting_period_id = $3`,
            [
              organizationId,

              comparison
                .metric_definition_id,

              comparison
                .current_reporting_period_id,
            ],
          );

          continue;
        }

        const findings =
          buildPerformanceFindings(
            comparison,
          );

        const desiredTypes =
          findings.map(
            (
              finding,
            ) =>
              finding.findingType,
          );

        if (
          desiredTypes.length >
          0
        ) {
          await client.query(
            `delete from verified_performance_findings
             where organization_id = $1
               and metric_definition_id = $2
               and current_reporting_period_id = $3
               and not (
                 finding_type =
                 any($4::text[])
               )`,
            [
              organizationId,

              comparison
                .metric_definition_id,

              comparison
                .current_reporting_period_id,

              desiredTypes,
            ],
          );
        } else {
          await client.query(
            `delete from verified_performance_findings
             where organization_id = $1
               and metric_definition_id = $2
               and current_reporting_period_id = $3`,
            [
              organizationId,

              comparison
                .metric_definition_id,

              comparison
                .current_reporting_period_id,
            ],
          );
        }

        for (
          const finding of
            findings
        ) {
          const result =
            await client.query(
              `insert into verified_performance_findings (
                 organization_id,
                 source_comparison_id,
                 metric_definition_id,
                 current_reporting_period_id,
                 finding_type,
                 severity,
                 status,
                 title,
                 summary,
                 evidence
               )
               values (
                 $1,
                 $2,
                 $3,
                 $4,
                 $5,
                 $6,
                 'active',
                 $7,
                 $8,
                 $9::jsonb
               )
               on conflict (
                 organization_id,
                 metric_definition_id,
                 current_reporting_period_id,
                 finding_type
               )
               do update set
                 source_comparison_id =
                   excluded.source_comparison_id,

                 severity =
                   excluded.severity,

                 status =
                   'active',

                 title =
                   excluded.title,

                 summary =
                   excluded.summary,

                 evidence =
                   excluded.evidence,

                 updated_at =
                   now()

               returning
                 id,
                 organization_id,
                 source_comparison_id,
                 metric_definition_id,
                 current_reporting_period_id,
                 finding_type,
                 severity,
                 status,
                 title,
                 summary,
                 evidence,
                 created_at,
                 updated_at`,
              [
                organizationId,

                comparison
                  .comparison_id,

                comparison
                  .metric_definition_id,

                comparison
                  .current_reporting_period_id,

                finding
                  .findingType,

                finding
                  .severity,

                finding
                  .title,

                finding
                  .summary,

                JSON.stringify(
                  finding.evidence,
                ),
              ],
            );

          persisted.push(
            mapFinding(
              result.rows[0],
            ),
          );
        }
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

  async listFindings({
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
               pf.id,
               pf.organization_id,
               pf.source_comparison_id,
               pf.metric_definition_id,
               pf.current_reporting_period_id,
               pf.finding_type,
               pf.severity,
               pf.status,
               pf.title,
               pf.summary,
               pf.evidence,
               pf.created_at,
               pf.updated_at,

               md.metric_key,
               md.label as metric_label,
               md.source_column,
               md.aggregation,
               md.unit,

               ds.id as data_stream_id,
               ds.name as data_stream_name,
               ds.display_name as data_stream_display_name,

               rp.period_start,
               rp.period_end,
               rp.label as period_label

             from verified_performance_findings pf

             join verified_metric_definitions md
               on md.id =
                 pf.metric_definition_id
              and md.organization_id =
                 pf.organization_id

             join data_streams ds
               on ds.id =
                 md.data_stream_id

             join reporting_periods rp
               on rp.id =
                 pf.current_reporting_period_id

             where pf.organization_id = $1

             order by
               rp.period_start desc,
               md.label asc,
               pf.finding_type asc`,
            [
              organizationId,
            ],
          );

        return result.rows.map(
          mapDetailedFinding,
        );
      },
    );
  }

  async listDashboardModules({
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
            `with ranked_findings as (
               select
                 pf.id,
                 pf.organization_id,
                 pf.source_comparison_id,
                 pf.metric_definition_id,
                 pf.current_reporting_period_id,
                 pf.finding_type,
                 pf.severity,
                 pf.status,
                 pf.title,
                 pf.summary,
                 pf.evidence,
                 pf.created_at,
                 pf.updated_at,

                 md.metric_key,
                 md.label as metric_label,
                 md.source_column,
                 md.aggregation,
                 md.unit,

                 ds.id as data_stream_id,
                 ds.name as data_stream_name,
                 ds.display_name as data_stream_display_name,

                 rp.period_start,
                 rp.period_end,
                 rp.label as period_label,

                 row_number() over (
                   partition by
                     pf.metric_definition_id,
                     pf.finding_type
                   order by
                     rp.period_start desc,
                     pf.updated_at desc,
                     pf.id desc
                 ) as finding_rank

               from verified_performance_findings pf

               join verified_metric_definitions md
                 on md.id =
                   pf.metric_definition_id
                and md.organization_id =
                   pf.organization_id

               join data_streams ds
                 on ds.id =
                   md.data_stream_id

               join reporting_periods rp
                 on rp.id =
                   pf.current_reporting_period_id

               where pf.organization_id = $1
                 and pf.status = 'active'
             )

             select
               id,
               organization_id,
               source_comparison_id,
               metric_definition_id,
               current_reporting_period_id,
               finding_type,
               severity,
               status,
               title,
               summary,
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
               period_start,
               period_end,
               period_label,
               finding_rank
             from ranked_findings
             where finding_rank = 1
             order by
               data_stream_display_name asc,
               metric_label asc,
               finding_type asc`,
            [
              organizationId,
            ],
          );

        const modules = {
          signals:
            [],

          risks:
            [],

          opportunities:
            [],

          focusAreas:
            [],
        };

        for (
          const row of
            result.rows
        ) {
          const finding =
            mapDetailedFinding(
              row,
            );

          switch (
            finding.findingType
          ) {
            case "signal":
              modules.signals.push(
                finding,
              );

              break;

            case "risk":
              modules.risks.push(
                finding,
              );

              break;

            case "opportunity":
              modules
                .opportunities
                .push(
                  finding,
                );

              break;

            case "focus_area":
              modules
                .focusAreas
                .push(
                  finding,
                );

              break;

            default:
              throw new PerformanceFindingError(
                "Stored performance finding type is invalid.",
                "FINDING_TYPE_INVALID",
              );
          }
        }

        return modules;
      },
    );
  }
}

export class PerformanceFindingError
  extends Error {
  constructor(
    message,
    code =
      "PERFORMANCE_FINDING_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "PerformanceFindingError";

    this.code =
      code;
  }
}

export function classifyMetricPolarity({
  metricKey,
  sourceColumn,
} = {}) {
  const source =
    normalizeMetricSemanticKey(
      sourceColumn,
    );

  const metric =
    normalizeMetricSemanticKey(
      String(
        metricKey ??
          "",
      ).replace(
        /^[^:]+:/,
        "",
      ),
    );

  const candidate =
    source ||
    metric;

  if (
    HIGHER_IS_BETTER.has(
      candidate,
    )
  ) {
    return "higher_is_better";
  }

  if (
    LOWER_IS_BETTER.has(
      candidate,
    )
  ) {
    return "lower_is_better";
  }

  return "neutral";
}

export function findingSeverity({
  percentChange,
  absoluteChange,
}) {
  if (
    percentChange ===
      null ||
    percentChange ===
      undefined
  ) {
    const absolute =
      Number(
        absoluteChange ??
          0,
      );

    return absolute ===
      0
      ? "info"
      : "low";
  }

  const magnitude =
    Math.abs(
      Number(
        percentChange,
      ),
    );

  if (
    !Number.isFinite(
      magnitude,
    )
  ) {
    throw new PerformanceFindingError(
      "Finding percentage is invalid.",
      "FINDING_VALUE_INVALID",
    );
  }

  if (
    magnitude >=
    25
  ) {
    return "high";
  }

  if (
    magnitude >=
    10
  ) {
    return "medium";
  }

  if (
    magnitude >
    0
  ) {
    return "low";
  }

  return "info";
}

function buildPerformanceFindings(
  comparison,
) {
  const polarity =
    classifyMetricPolarity({
      metricKey:
        comparison
          .metric_key,

      sourceColumn:
        comparison
          .source_column,
    });

  const severity =
    findingSeverity({
      percentChange:
        comparison
          .percent_change_numeric,

      absoluteChange:
        comparison
          .absolute_change_numeric,
    });

  const baseEvidence =
    buildEvidence({
      comparison,
      polarity,
    });

  const findings = [
    {
      findingType:
        "signal",

      severity,

      title:
        `${comparison.metric_label} moved ${comparison.direction}`,

      summary:
        movementSummary(
          comparison,
        ),

      evidence: {
        ...baseEvidence,

        interpretation:
          "factual_movement",
      },
    },

    {
      findingType:
        "focus_area",

      severity,

      title:
        `Review ${comparison.metric_label} movement`,

      summary:
        [
          movementSummary(
            comparison,
          ),
          "Review the underlying business drivers before taking action.",
        ].join(
          " ",
        ),

      evidence: {
        ...baseEvidence,

        interpretation:
          "review_required",
      },
    },
  ];

  const directionalType =
    directionalFindingType({
      polarity,
      direction:
        comparison.direction,
    });

  if (
    directionalType
  ) {
    findings.push({
      findingType:
        directionalType,

      severity,

      title:
        directionalType ===
        "opportunity"
          ? `${comparison.metric_label}: favorable verified movement`
          : `${comparison.metric_label}: adverse verified movement`,

      summary:
        movementSummary(
          comparison,
        ),

      evidence: {
        ...baseEvidence,

        interpretation:
          directionalType,

        semanticRule:
          "deterministic_metric_semantics_v1",
      },
    });
  }

  return findings;
}

function directionalFindingType({
  polarity,
  direction,
}) {
  if (
    direction ===
    "flat"
  ) {
    return null;
  }

  if (
    polarity ===
    "higher_is_better"
  ) {
    if (
      direction ===
      "up"
    ) {
      return "opportunity";
    }

    if (
      direction ===
      "down"
    ) {
      return "risk";
    }
  }

  if (
    polarity ===
    "lower_is_better"
  ) {
    if (
      direction ===
      "up"
    ) {
      return "risk";
    }

    if (
      direction ===
      "down"
    ) {
      return "opportunity";
    }
  }

  return null;
}

function buildEvidence({
  comparison,
  polarity,
}) {
  const comparisonEvidence =
    comparison
      .comparison_evidence ??
    {};

  return {
    kind:
      "performance_finding",

    evidenceVersion:
      "deterministic-v1",

    sourceComparisonId:
      comparison
        .comparison_id,

    metricDefinitionId:
      comparison
        .metric_definition_id,

    metricKey:
      comparison.metric_key,

    metricLabel:
      comparison.metric_label,

    sourceColumn:
      comparison.source_column,

    aggregation:
      comparison.aggregation,

    metricPolarity:
      polarity,

    direction:
      comparison.direction,

    previousValue:
      normalizeDatabaseNumericNullable(
        comparison
          .previous_value_numeric,
      ),

    currentValue:
      normalizeDatabaseNumeric(
        comparison
          .current_value_numeric,
      ),

    absoluteChange:
      normalizeDatabaseNumericNullable(
        comparison
          .absolute_change_numeric,
      ),

    percentChange:
      normalizeDatabaseNumericNullable(
        comparison
          .percent_change_numeric,
      ),

    previousMetricPointId:
      comparison
        .previous_metric_point_id,

    currentMetricPointId:
      comparison
        .current_metric_point_id,

    previousReportingPeriodId:
      comparison
        .previous_reporting_period_id,

    currentReportingPeriodId:
      comparison
        .current_reporting_period_id,

    previousRawDataObjectId:
      comparisonEvidence
        .previousRawDataObjectId ??
      null,

    currentRawDataObjectId:
      comparisonEvidence
        .currentRawDataObjectId ??
      null,

    previousIngestionRunId:
      comparisonEvidence
        .previousIngestionRunId ??
      null,

    currentIngestionRunId:
      comparisonEvidence
        .currentIngestionRunId ??
      null,

    previousPeriod: {
      id:
        comparison
          .previous_reporting_period_id,

      periodStart:
        comparison
          .previous_period_start,

      periodEnd:
        comparison
          .previous_period_end,

      label:
        comparison
          .previous_period_label,
    },

    currentPeriod: {
      id:
        comparison
          .current_reporting_period_id,

      periodStart:
        comparison
          .current_period_start,

      periodEnd:
        comparison
          .current_period_end,

      label:
        comparison
          .current_period_label,
    },

    sourceComparisonEvidence:
      comparisonEvidence,
  };
}

function movementSummary(
  comparison,
) {
  const previous =
    normalizeDatabaseNumeric(
      comparison
        .previous_value_numeric,
    );

  const current =
    normalizeDatabaseNumeric(
      comparison
        .current_value_numeric,
    );

  const absolute =
    normalizeDatabaseNumeric(
      comparison
        .absolute_change_numeric,
    );

  const percent =
    normalizeDatabaseNumericNullable(
      comparison
        .percent_change_numeric,
    );

  const periodText =
    [
      comparison
        .previous_period_label,

      comparison
        .current_period_label,
    ]
      .filter(
        Boolean,
      )
      .join(
        " to ",
      );

  const percentText =
    percent ===
    null
      ? "Percent change is unavailable because the previous value was zero."
      : `Percent change: ${signedNumber(percent)}%.`;

  return [
    `${comparison.metric_label} changed from ${previous} to ${current}${periodText ? ` from ${periodText}` : ""}.`,

    `Absolute change: ${signedNumber(absolute)}.`,

    percentText,
  ].join(
    " ",
  );
}

function signedNumber(
  value,
) {
  const text =
    String(
      value ??
        "0",
    );

  if (
    text.startsWith(
      "-",
    ) ||
    text ===
      "0"
  ) {
    return text;
  }

  return `+${text}`;
}

function normalizeMetricSemanticKey(
  value,
) {
  return String(
    value ??
      "",
  )
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "_",
    )
    .replace(
      /^_+|_+$/g,
      "",
    );
}

function mapFinding(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    sourceComparisonId:
      row.source_comparison_id,

    metricDefinitionId:
      row.metric_definition_id,

    currentReportingPeriodId:
      row.current_reporting_period_id,

    findingType:
      row.finding_type,

    severity:
      row.severity,

    status:
      row.status,

    title:
      row.title,

    summary:
      row.summary,

    evidence:
      row.evidence ??
      {},

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapDetailedFinding(
  row,
) {
  return {
    ...mapFinding(
      row,
    ),

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

    dataStream: {
      id:
        row.data_stream_id,

      name:
        row.data_stream_name,

      displayName:
        row.data_stream_display_name,
    },

    reportingPeriod: {
      id:
        row.current_reporting_period_id,

      periodStart:
        row.period_start,

      periodEnd:
        row.period_end,

      label:
        row.period_label,
    },
  };
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
    throw new PerformanceFindingError(
      message,
      "PERFORMANCE_FINDING_INVALID",
    );
  }
}

function normalizeDatabaseNumericNullable(
  value,
) {
  if (
    value ===
      null ||
    value ===
      undefined
  ) {
    return null;
  }

  return normalizeDatabaseNumeric(
    value,
  );
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

async function safeRollback(
  client,
) {
  try {
    await client.query(
      "rollback",
    );
  } catch {
    /*
     * Preserve original failure.
     */
  }
}
