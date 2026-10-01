import { withTenantTransaction } from "./postgres.mjs";

const EVENT_LABELS = new Map([
  ["organization.created", "Business workspace created"],
  ["organization.switched", "Business workspace selected"],
  ["business_profile.created", "Business profile created"],
  ["business_profile.updated", "Business profile updated"],
  ["business_onboarding.completed", "Business onboarding completed"],
  ["business_model_entry.created", "Business model added"],
  ["business_fact.created", "Business fact added"],
  ["business_term.created", "Business term added"],
  ["business_goal.created", "Business goal added"],
  ["kpi_definition.created", "KPI definition added"],
  ["data_source.created", "Data source created"],
  ["data_stream.created", "Data stream created"],
  ["ingestion_run.created", "Data upload started"],
  ["ingestion_run.validated", "Data upload validated"],
  ["ingestion_run.processing", "Data processing started"],
  ["ingestion_run.completed", "Data processing completed"],
  ["ingestion_run.failed", "Data processing failed"],
  ["semantic_mapping.created", "Data mapping created"],
  ["semantic_mapping.activated", "Data mapping activated"],
  ["metric_spec.created", "Metric definition created"],
  ["metric_run.created", "Metric calculation started"],
  ["metric_run.completed", "Metric calculation completed"],
  ["metric_run.failed", "Metric calculation failed"],
  ["report.definition_approved", "Evidence definition approved"],
  ["billing.checkout_started", "Subscription checkout started"],
  ["billing.subscription_activated", "Subscription activated"],
  ["billing.subscription_renewed", "Subscription renewed"],
  ["billing.subscription_past_due", "Subscription payment requires attention"],
  ["billing.subscription_non_renewing", "Subscription set to end"],
  ["billing.subscription_canceled", "Subscription canceled"],
  ["business_action.created", "Business action created"],
  ["business_action.updated", "Business action updated"],
  ["business_action.status_updated", "Business action status changed"],
  ["business_outcome.created", "Business outcome recorded"],
  ["business_outcome.updated", "Business outcome updated"],
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
  ["ingestion_run", "Data upload"],
  ["upload", "Data upload"],
  ["semantic_mapping", "Data mapping"],
  ["metric_calculation_spec", "Metric definition"],
  ["verified_metric_run", "Verified metrics"],
  ["report_metric", "Evidence report"],
  ["organization_subscription", "Subscription"],
  ["business_action", "Business action"],
  ["business_outcome", "Business outcome"],
]);

export class PostgresActivityRepository {
  constructor(pool) {
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

        return result.rows.map(mapActivityEvent);
      },
    );
  }
}

export function mapActivityEvent(row) {
  const metadata = normalizeMetadata(row.metadata);

  return {
    id: row.id,

    eventType: row.event_type,

    targetType: row.target_type,

    targetId: row.target_id ?? null,

    actorUserId: row.actor_user_id ?? null,

    label: eventLabel(row.event_type),

    detail: activityDetail({
      targetType: row.target_type,

      metadata,
    }),

    metadata,

    createdAt: row.created_at,
  };
}

function eventLabel(eventType) {
  return EVENT_LABELS.get(eventType) ?? humanize(eventType);
}

function activityDetail({ targetType, metadata }) {
  const target = TARGET_LABELS.get(targetType) ?? humanize(targetType);

  const details = [target];

  const fileName = cleanText(metadata.fileName ?? metadata.file_name);

  const column = cleanText(metadata.column);

  const period = cleanText(metadata.period);

  const status = cleanText(metadata.status);

  if (fileName) {
    details.push(fileName);
  } else if (column) {
    details.push(column);
  } else if (period) {
    details.push(period);
  } else if (status) {
    details.push(status);
  }

  const rowCount = Number(metadata.rowCount ?? metadata.row_count);

  if (Number.isFinite(rowCount) && rowCount >= 0) {
    details.push(`${rowCount} ${rowCount === 1 ? "row" : "rows"}`);
  }

  return details.join(" · ");
}

function cleanText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
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
