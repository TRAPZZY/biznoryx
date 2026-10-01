import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";
import { withTenantTransaction } from "./postgres.mjs";

const EVENT_LABELS = new Map([
  ["organization.created", "Business workspace created"],
  ["organization.switched", "Business workspace selected"],

  ["business_profile.created", "Business profile created"],
  ["business_profile.updated", "Business profile updated"],
  ["business_onboarding.completed", "Business onboarding completed"],

  ["business_model_entry.created", "Business model entry added"],
  ["business_fact.created", "Business fact captured"],
  ["business_term.created", "Business term added"],
  ["business_goal.created", "Business goal added"],
  ["kpi_definition.created", "KPI definition added"],

  ["data_source.created", "Data source created"],
  ["data_stream.created", "Data stream created"],

  ["ingestion.validated", "Upload validated"],
  ["ingestion.confirmed", "Upload confirmed"],

  ["ingestion_run.created", "Upload created"],
  ["ingestion_run.validated", "Upload validated"],
  ["ingestion_run.processing", "Upload processing"],
  ["ingestion_run.completed", "Upload processed"],
  ["ingestion_run.rejected", "Upload rejected"],
  ["ingestion_run.failed", "Upload failed"],

  ["semantic_mapping.created", "Data mapping created"],
  ["semantic_mapping.activated", "Data mapping activated"],

  ["metric_spec.created", "Metric definition created"],
  ["metric_run.created", "Metric calculation started"],
  ["metric_run.completed", "Metric calculation completed"],
  ["metric_run.failed", "Metric calculation failed"],

  ["report.definition_approved", "Evidence definition approved"],

  ["billing.checkout_started", "Billing checkout started"],
  ["billing.subscription_activated", "Subscription activated"],
  ["billing.subscription_renewed", "Subscription renewed"],
  ["billing.subscription_past_due", "Subscription payment requires attention"],
  ["billing.subscription_non_renewing", "Subscription set to end"],
  ["billing.subscription_canceled", "Subscription canceled"],
]);

const TARGET_LABELS = new Map([
  ["organization", "Business workspace"],
  ["business_profile", "Business profile"],
  ["business_model_entry", "Business model"],
  ["business_fact", "Business fact"],
  ["business_term", "Business term"],
  ["business_goal", "Business goal"],
  ["kpi_definition", "KPI definition"],

  ["data_source", "Data source"],
  ["data_stream", "Data stream"],

  ["upload", "Business data upload"],
  ["ingestion_run", "Business data upload"],

  ["semantic_mapping", "Data mapping"],
  ["metric_calculation_spec", "Metric definition"],
  ["verified_metric_run", "Verified metric run"],

  ["report_metric", "Evidence report"],
  ["organization_subscription", "Subscription"],
]);

export class PostgresActivityRepository {
  constructor(pool) {
    if (!pool) {
      throw new Error("PostgreSQL pool is required for Activity.");
    }

    this.pool = pool;
  }

  async listActivity({ organizationId, actorUserId, limit = 100 }) {
    const safeLimit = normalizeLimit(limit);

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

        const result = await client.query(
          `select
               id,
               organization_id,
               actor_user_id,
               event_type,
               target_type,
               target_id,
               metadata,
               created_at
             from audit_events
             where organization_id = $1
             order by created_at desc, id desc
             limit $2`,
          [organizationId, safeLimit],
        );

        return result.rows.map(presentActivity);
      },
    );
  }
}

async function requireReadAccess({ client, organizationId, actorUserId }) {
  const role = await membershipRole({ client, organizationId, actorUserId });
  const capabilities = ROLE_CAPABILITIES[role] ?? [];

  if (!capabilities.includes(CAPABILITIES.READ_AUDIT_LOG)) {
    throw new AuthError("Capability required: audit.read", "CAPABILITY_DENIED");
  }
}

async function membershipRole({ client, organizationId, actorUserId }) {
  const result = await client.query(
    `select role
       from organization_memberships
       where organization_id = $1
         and user_id = $2
         and status = 'active'
       limit 1`,
    [organizationId, actorUserId],
  );

  const membership = result.rows[0];

  if (!membership) {
    throw new AuthError("Active organization membership required.", "ORG_ACCESS_DENIED");
  }

  return membership.role;
}

function presentActivity(row) {
  const metadata = normalizeMetadata(row.metadata);

  return {
    id: row.id,

    eventType: row.event_type,

    targetType: row.target_type,

    targetId: row.target_id ?? null,

    actorUserId: row.actor_user_id ?? null,

    label: EVENT_LABELS.get(row.event_type) ?? humanize(row.event_type),

    detail: buildDetail(row.target_type, metadata),

    createdAt: row.created_at,
  };
}

function buildDetail(targetType, metadata) {
  const parts = [TARGET_LABELS.get(targetType) ?? humanize(targetType)];

  const detailValue = firstString([
    metadata.fileName,
    metadata.file_name,
    metadata.filename,
    metadata.period,
    metadata.status,
    metadata.column,
    metadata.provider,
    metadata.factKind,
  ]);

  if (detailValue) {
    parts.push(detailValue);
  }

  const rawRowCount = metadata.rowCount ?? metadata.row_count;

  if (rawRowCount !== undefined && rawRowCount !== null) {
    const rowCount = Number(rawRowCount);

    if (Number.isFinite(rowCount) && rowCount >= 0) {
      parts.push(`${rowCount} ${rowCount === 1 ? "row" : "rows"}`);
    }
  }

  return parts.join(" · ");
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed)) {
    return 100;
  }

  return Math.min(Math.max(parsed, 1), 200);
}

function humanize(value) {
  const text = String(value ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "Activity";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}
