import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const ACTION_STATUSES =
  new Set([
    "planned",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
  ]);

const STATUS_TRANSITIONS =
  new Map([
    [
      "planned",
      new Set([
        "in_progress",
        "cancelled",
      ]),
    ],

    [
      "in_progress",
      new Set([
        "blocked",
        "completed",
        "cancelled",
      ]),
    ],

    [
      "blocked",
      new Set([
        "in_progress",
        "cancelled",
      ]),
    ],

    [
      "completed",
      new Set(),
    ],

    [
      "cancelled",
      new Set(),
    ],
  ]);

export class PostgresBusinessActionsRepository {
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

  async createFromFinding({
    organizationId,
    actorUserId,
    findingId,
    action,
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
      findingId,
      "Finding is required.",
    );

    const normalizedAction =
      normalizeActionInput(
        action,
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

        /*
         * Idempotency:
         *
         * One production action is allowed per
         * verified finding in this slice.
         *
         * Retrying the exact command therefore
         * returns the durable existing action
         * instead of creating duplicates.
         */
        const existing =
          await selectActionByFinding({
            client,
            organizationId,
            findingId,
          });

        if (
          existing
        ) {
          return mapAction(
            existing,
          );
        }

        const findingResult =
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

               rp.period_start,
               rp.period_end,
               rp.label as period_label

             from verified_performance_findings pf

             join verified_metric_definitions md
               on md.id =
                 pf.metric_definition_id
              and md.organization_id =
                 pf.organization_id

             join reporting_periods rp
               on rp.id =
                 pf.current_reporting_period_id

             where pf.organization_id = $1
               and pf.id = $2

             limit 1`,
            [
              organizationId,
              findingId,
            ],
          );

        const finding =
          findingResult.rows[0];

        if (
          !finding
        ) {
          throw new AuthError(
            "Finding was not found.",
            "ORG_ACCESS_DENIED",
          );
        }

        if (
          finding.status !==
          "active"
        ) {
          throw new BusinessActionError(
            "Only an active verified finding can create a new action.",
            "FINDING_NOT_ACTIONABLE",
          );
        }

        const ownerUserId =
          normalizedAction
            .ownerUserId ??
          actorUserId;

        await requireOwnedActiveMember({
          client,
          organizationId,
          userId:
            ownerUserId,
        });

        const evidence =
          createActionEvidence({
            finding,
          });

        const created =
          await client.query(
            `insert into verified_business_actions (
               organization_id,
               source_finding_id,
               title,
               description,
               status,
               owner_user_id,
               due_date,
               evidence,
               created_by_user_id
             )
             values (
               $1,
               $2,
               $3,
               $4,
               'planned',
               $5,
               $6::date,
               $7::jsonb,
               $8
             )
             returning
               id,
               organization_id,
               source_finding_id,
               title,
               description,
               status,
               owner_user_id,
               due_date,
               evidence,
               created_by_user_id,
               completed_at,
               created_at,
               updated_at`,
            [
              organizationId,

              findingId,

              normalizedAction
                .title,

              normalizedAction
                .description,

              ownerUserId,

              normalizedAction
                .dueDate,

              JSON.stringify(
                evidence,
              ),

              actorUserId,
            ],
          );

        /*
         * Creating a durable action means the
         * organization has explicitly accepted
         * the finding for action.
         *
         * This update shares the same transaction
         * as the action insert.
         */
        await client.query(
          `update verified_performance_findings
           set
             status = 'accepted',
             updated_at = now()
           where organization_id = $1
             and id = $2`,
          [
            organizationId,
            findingId,
          ],
        );

        return mapAction({
          ...created.rows[0],

          source_finding_status:
            "accepted",

          source_finding_type:
            finding.finding_type,

          source_finding_severity:
            finding.severity,

          source_finding_title:
            finding.title,

          source_finding_summary:
            finding.summary,

          source_finding_evidence:
            finding.evidence,

          metric_key:
            finding.metric_key,

          metric_label:
            finding.metric_label,

          source_column:
            finding.source_column,

          aggregation:
            finding.aggregation,

          unit:
            finding.unit,

          period_start:
            finding.period_start,

          period_end:
            finding.period_end,

          period_label:
            finding.period_label,
        });
      },
    );
  }

  async updateStatus({
    organizationId,
    actorUserId,
    actionId,
    status,
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

    validateActionStatus(
      status,
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

        const current =
          await selectActionById({
            client,
            organizationId,
            actionId,
          });

        if (
          !current
        ) {
          throw new AuthError(
            "Action was not found.",
            "ORG_ACCESS_DENIED",
          );
        }

        if (
          current.status ===
          status
        ) {
          return mapAction(
            current,
          );
        }

        if (
          !canTransitionActionStatus(
            current.status,
            status,
          )
        ) {
          throw new BusinessActionError(
            `Action cannot move from "${current.status}" to "${status}".`,
            "ACTION_STATUS_TRANSITION_INVALID",
          );
        }

        const updated =
          await client.query(
            `update verified_business_actions
             set
               status = $3,

               completed_at =
                 case
                   when $3 = 'completed'
                     then now()
                   else null
                 end,

               updated_at = now()

             where organization_id = $1
               and id = $2

             returning
               id,
               organization_id,
               source_finding_id,
               title,
               description,
               status,
               owner_user_id,
               due_date,
               evidence,
               created_by_user_id,
               completed_at,
               created_at,
               updated_at`,
            [
              organizationId,
              actionId,
              status,
            ],
          );

        return mapAction({
          ...updated.rows[0],

          source_finding_status:
            current
              .source_finding_status,

          source_finding_type:
            current
              .source_finding_type,

          source_finding_severity:
            current
              .source_finding_severity,

          source_finding_title:
            current
              .source_finding_title,

          source_finding_summary:
            current
              .source_finding_summary,

          source_finding_evidence:
            current
              .source_finding_evidence,

          metric_key:
            current.metric_key,

          metric_label:
            current.metric_label,

          source_column:
            current.source_column,

          aggregation:
            current.aggregation,

          unit:
            current.unit,

          period_start:
            current.period_start,

          period_end:
            current.period_end,

          period_label:
            current.period_label,
        });
      },
    );
  }

  async listActions({
    organizationId,
    actorUserId,
  }) {
    validateIdentifier(
      organizationId,
      "Organization is required.",
    );

    validateIdentifier(
      actorUserId,
      "Actor user is required.",
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
               a.id,
               a.organization_id,
               a.source_finding_id,
               a.title,
               a.description,
               a.status,
               a.owner_user_id,
               a.due_date,
               a.evidence,
               a.created_by_user_id,
               a.completed_at,
               a.created_at,
               a.updated_at,

               pf.status as source_finding_status,
               pf.finding_type as source_finding_type,
               pf.severity as source_finding_severity,
               pf.title as source_finding_title,
               pf.summary as source_finding_summary,
               pf.evidence as source_finding_evidence,

               md.metric_key,
               md.label as metric_label,
               md.source_column,
               md.aggregation,
               md.unit,

               rp.period_start,
               rp.period_end,
               rp.label as period_label

             from verified_business_actions a

             join verified_performance_findings pf
               on pf.id =
                 a.source_finding_id
              and pf.organization_id =
                 a.organization_id

             join verified_metric_definitions md
               on md.id =
                 pf.metric_definition_id
              and md.organization_id =
                 pf.organization_id

             join reporting_periods rp
               on rp.id =
                 pf.current_reporting_period_id

             where a.organization_id = $1

             order by
               case a.status
                 when 'in_progress' then 1
                 when 'blocked' then 2
                 when 'planned' then 3
                 when 'completed' then 4
                 when 'cancelled' then 5
                 else 6
               end,
               a.due_date asc nulls last,
               a.updated_at desc,
               a.id desc`,
            [
              organizationId,
            ],
          );

        return result.rows
          .map(
            mapAction,
          );
      },
    );
  }
}

export class BusinessActionError
  extends Error {
  constructor(
    message,
    code =
      "BUSINESS_ACTION_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "BusinessActionError";

    this.code =
      code;
  }
}

export function canTransitionActionStatus(
  fromStatus,
  toStatus,
) {
  if (
    !ACTION_STATUSES.has(
      fromStatus,
    ) ||
    !ACTION_STATUSES.has(
      toStatus,
    )
  ) {
    return false;
  }

  if (
    fromStatus ===
    toStatus
  ) {
    return true;
  }

  return (
    STATUS_TRANSITIONS
      .get(
        fromStatus,
      )
      ?.has(
        toStatus,
      ) ??
    false
  );
}

function normalizeActionInput(
  action,
) {
  if (
    !action ||
    typeof action !==
      "object" ||
    Array.isArray(
      action,
    )
  ) {
    throw new BusinessActionError(
      "Action details are required.",
      "BUSINESS_ACTION_INVALID",
    );
  }

  const title =
    cleanText(
      action.title,
    );

  if (
    !title ||
    title.length >
      200
  ) {
    throw new BusinessActionError(
      "Action title is required and must not exceed 200 characters.",
      "BUSINESS_ACTION_INVALID",
    );
  }

  const description =
    cleanText(
      action.description,
    );

  if (
    description.length >
    4_000
  ) {
    throw new BusinessActionError(
      "Action description must not exceed 4000 characters.",
      "BUSINESS_ACTION_INVALID",
    );
  }

  const ownerUserId =
    cleanText(
      action.ownerUserId,
    ) ||
    null;

  const dueDate =
    normalizeDueDate(
      action.dueDate,
    );

  return {
    title,
    description,
    ownerUserId,
    dueDate,
  };
}

function normalizeDueDate(
  value,
) {
  if (
    value ===
      undefined ||
    value ===
      null ||
    String(
      value,
    ).trim() ===
      ""
  ) {
    return null;
  }

  const text =
    String(
      value,
    ).trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      text,
    )
  ) {
    throw new BusinessActionError(
      "Action due date must use YYYY-MM-DD format.",
      "BUSINESS_ACTION_INVALID",
    );
  }

  const date =
    new Date(
      `${text}T00:00:00.000Z`,
    );

  if (
    Number.isNaN(
      date.getTime(),
    ) ||
    date
      .toISOString()
      .slice(
        0,
        10,
      ) !==
      text
  ) {
    throw new BusinessActionError(
      "Action due date is invalid.",
      "BUSINESS_ACTION_INVALID",
    );
  }

  return text;
}

function validateActionStatus(
  status,
) {
  if (
    !ACTION_STATUSES.has(
      status,
    )
  ) {
    throw new BusinessActionError(
      "Action status is invalid.",
      "BUSINESS_ACTION_INVALID",
    );
  }
}

async function selectActionByFinding({
  client,
  organizationId,
  findingId,
}) {
  const result =
    await client.query(
      `select
         a.id,
         a.organization_id,
         a.source_finding_id,
         a.title,
         a.description,
         a.status,
         a.owner_user_id,
         a.due_date,
         a.evidence,
         a.created_by_user_id,
         a.completed_at,
         a.created_at,
         a.updated_at,

         pf.status as source_finding_status,
         pf.finding_type as source_finding_type,
         pf.severity as source_finding_severity,
         pf.title as source_finding_title,
         pf.summary as source_finding_summary,
         pf.evidence as source_finding_evidence,

         md.metric_key,
         md.label as metric_label,
         md.source_column,
         md.aggregation,
         md.unit,

         rp.period_start,
         rp.period_end,
         rp.label as period_label

       from verified_business_actions a

       join verified_performance_findings pf
         on pf.id =
           a.source_finding_id
        and pf.organization_id =
           a.organization_id

       join verified_metric_definitions md
         on md.id =
           pf.metric_definition_id
        and md.organization_id =
           pf.organization_id

       join reporting_periods rp
         on rp.id =
           pf.current_reporting_period_id

       where a.organization_id = $1
         and a.source_finding_id = $2

       limit 1`,
      [
        organizationId,
        findingId,
      ],
    );

  return (
    result.rows[0] ??
    null
  );
}

async function selectActionById({
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
         a.description,
         a.status,
         a.owner_user_id,
         a.due_date,
         a.evidence,
         a.created_by_user_id,
         a.completed_at,
         a.created_at,
         a.updated_at,

         pf.status as source_finding_status,
         pf.finding_type as source_finding_type,
         pf.severity as source_finding_severity,
         pf.title as source_finding_title,
         pf.summary as source_finding_summary,
         pf.evidence as source_finding_evidence,

         md.metric_key,
         md.label as metric_label,
         md.source_column,
         md.aggregation,
         md.unit,

         rp.period_start,
         rp.period_end,
         rp.label as period_label

       from verified_business_actions a

       join verified_performance_findings pf
         on pf.id =
           a.source_finding_id
        and pf.organization_id =
           a.organization_id

       join verified_metric_definitions md
         on md.id =
           pf.metric_definition_id
        and md.organization_id =
           pf.organization_id

       join reporting_periods rp
         on rp.id =
           pf.current_reporting_period_id

       where a.organization_id = $1
         and a.id = $2

       limit 1`,
      [
        organizationId,
        actionId,
      ],
    );

  return (
    result.rows[0] ??
    null
  );
}

function createActionEvidence({
  finding,
}) {
  return {
    kind:
      "verified_business_action",

    evidenceVersion:
      "deterministic-v1",

    sourceFindingId:
      finding.id,

    sourceComparisonId:
      finding
        .source_comparison_id,

    findingType:
      finding
        .finding_type,

    findingSeverity:
      finding.severity,

    findingTitle:
      finding.title,

    findingSummary:
      finding.summary,

    metric: {
      key:
        finding.metric_key,

      label:
        finding.metric_label,

      sourceColumn:
        finding.source_column,

      aggregation:
        finding.aggregation,

      unit:
        finding.unit,
    },

    reportingPeriod: {
      id:
        finding
          .current_reporting_period_id,

      periodStart:
        finding.period_start,

      periodEnd:
        finding.period_end,

      label:
        finding.period_label,
    },

    sourceFindingEvidence:
      finding.evidence ??
      {},
  };
}

function mapAction(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    sourceFindingId:
      row.source_finding_id,

    title:
      row.title,

    description:
      row.description,

    status:
      row.status,

    ownerUserId:
      row.owner_user_id,

    dueDate:
      normalizeDateOnly(
        row.due_date,
      ),

    evidence:
      row.evidence ??
      {},

    createdByUserId:
      row.created_by_user_id,

    completedAt:
      row.completed_at,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,

    sourceFinding: {
      id:
        row.source_finding_id,

      status:
        row
          .source_finding_status,

      findingType:
        row
          .source_finding_type,

      severity:
        row
          .source_finding_severity,

      title:
        row
          .source_finding_title,

      summary:
        row
          .source_finding_summary,

      evidence:
        row
          .source_finding_evidence ??
        {},
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

    reportingPeriod: {
      periodStart:
        row.period_start,

      periodEnd:
        row.period_end,

      label:
        row.period_label,
    },
  };
}

async function requireWriteAccess({
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
    ] ??
    [];

  if (
    !capabilities.includes(
      CAPABILITIES
        .WRITE_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.write",
      "CAPABILITY_DENIED",
    );
  }
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
    ] ??
    [];

  if (
    !capabilities.includes(
      CAPABILITIES
        .READ_BUSINESS_DATA,
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

  if (
    !membership
  ) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  return membership.role;
}

async function requireOwnedActiveMember({
  client,
  organizationId,
  userId,
}) {
  const result =
    await client.query(
      `select
         user_id
       from organization_memberships
       where organization_id = $1
         and user_id = $2
         and status = 'active'
       limit 1`,
      [
        organizationId,
        userId,
      ],
    );

  if (
    !result.rows[0]
  ) {
    throw new AuthError(
      "Action owner must be an active organization member.",
      "ORG_ACCESS_DENIED",
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
    throw new BusinessActionError(
      message,
      "BUSINESS_ACTION_INVALID",
    );
  }
}

function cleanText(
  value,
) {
  return String(
    value ??
      "",
  ).trim();
}

function normalizeDateOnly(
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

  if (
    value instanceof
      Date &&
    !Number.isNaN(
      value.getTime(),
    )
  ) {
    return value
      .toISOString()
      .slice(
        0,
        10,
      );
  }

  const text =
    String(
      value,
    );

  return text.slice(
    0,
    10,
  );
}