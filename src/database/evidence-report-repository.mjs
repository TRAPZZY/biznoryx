import { AuthError, CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import { withTenantTransaction } from "./postgres.mjs";
import { validateReportPolicy } from "../reports/evidence-engine.mjs";

export class PostgresEvidenceReportRepository {
  constructor(pool) { this.pool = pool; }

  async listPolicies(context) {
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireCapability(client, context, CAPABILITIES.READ_BUSINESS_DATA);
      const result = await client.query(
        `select distinct on (series_key, source_column) series_key, source_column, version,
           label, unit, polarity, materiality_percent, approved_at, approved_by_user_id, revenue_breakdown
         from evidence_report_definitions where organization_id = $1
         order by series_key, source_column, version desc`, [context.organizationId]);
      return result.rows.map(mapPolicy);
    });
  }

  async approvePolicy(context) {
    const definition = validateReportPolicy(context.definition);
    const { seriesKey, column, expectedVersion = 0 } = context;
    if (typeof seriesKey !== "string" || !seriesKey || seriesKey.length > 180 || typeof column !== "string" || !column || column.length > 160 || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw new AuthError("Metric definition is invalid.", "VALIDATION_FAILED");
    if (definition.revenueBreakdown && [definition.revenueBreakdown.productColumn, definition.revenueBreakdown.quantityColumn].includes(column)) throw new AuthError("Revenue, product and quantity columns must be distinct.", "VALIDATION_FAILED");
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireCapability(client, context, CAPABILITIES.WRITE_BUSINESS_DATA);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([context.organizationId, seriesKey, column])]);
      const latest = await client.query(
        `select coalesce(max(version), 0)::integer as version from evidence_report_definitions
         where organization_id = $1 and series_key = $2 and source_column = $3`,
        [context.organizationId, seriesKey, column]);
      const version = latest.rows[0].version;
      if (version !== expectedVersion) throw new AuthError("This definition changed. Refresh the report before saving again.", "VALIDATION_FAILED");
      const result = await client.query(
        `insert into evidence_report_definitions (organization_id, series_key, source_column, version,
           label, unit, polarity, materiality_percent, approved_by_user_id, revenue_breakdown)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         returning series_key, source_column, version, label, unit, polarity, materiality_percent, approved_at, approved_by_user_id, revenue_breakdown`,
        [context.organizationId, seriesKey, column, version + 1, definition.label, definition.unit, definition.polarity, definition.materialityPercent, context.actorUserId, definition.revenueBreakdown ? JSON.stringify(definition.revenueBreakdown) : null]);
      return mapPolicy(result.rows[0]);
    });
  }
}

async function requireCapability(client, context, capability) {
  const result = await client.query(
    `select role from organization_memberships where organization_id = $1 and user_id = $2 and status = 'active' limit 1`,
    [context.organizationId, context.actorUserId]);
  if (!ROLE_CAPABILITIES[result.rows[0]?.role]?.includes(capability)) throw new AuthError("Organization access denied.", "ORG_ACCESS_DENIED");
}

function mapPolicy(row) {
  return { seriesKey: row.series_key, column: row.source_column, version: row.version,
    label: row.label, unit: row.unit, polarity: row.polarity, materialityPercent: Number(row.materiality_percent),
    approvedAt: row.approved_at, approvedByUserId: row.approved_by_user_id, revenueBreakdown: row.revenue_breakdown ?? null };
}
