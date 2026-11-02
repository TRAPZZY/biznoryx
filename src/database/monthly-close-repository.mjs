import { CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import { withTenantTransaction } from "./postgres.mjs";
import { buildBusinessReport } from "../reports/evidence-engine.mjs";
import { reportSourcesFromSeries } from "../reports/production-sources.mjs";
import { readMoneyTrailSnapshot } from "./money-trail-repository.mjs";
import {
  approvalBlockers,
  buildMonthlyClosePacket,
  canonicalJson,
  monthlyCloseError,
  monthlyCloseHash,
  validateCloseId,
  validateClosePeriod,
} from "../reports/monthly-close.mjs";

const SELECT_CLOSE = `select v.*, a.approved_by_user_id, a.approved_by_name, a.approved_by_role, a.approved_at,
  next.close_id as superseded_by_id,
  case when next.close_id is not null then 'superseded' when a.close_id is not null then 'approved' else 'draft' end as status
  from monthly_close_versions v
  left join monthly_close_approvals a on a.organization_id = v.organization_id and a.close_id = v.id
  left join monthly_close_approvals next on next.organization_id = v.organization_id and next.supersedes_id = v.id`;

export class PostgresMonthlyCloseRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async available() {
    const result = await this.pool.query(
      "select to_regclass('public.monthly_close_versions') is not null and to_regclass('public.monthly_close_approvals') is not null and to_regclass('public.monthly_source_sets') is not null as available",
    );
    return result.rows[0].available;
  }

  async sourceRequirements(context) {
    validateClosePeriod(context.period);
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireMember(client, context, CAPABILITIES.READ_BUSINESS_DATA);
      const options = await client.query(
        "select id,display_name from data_streams where organization_id=$1 order by display_name,id limit 100",
        [context.organizationId],
      );
      return {
        options: options.rows.map((r) => ({ id: r.id, name: r.display_name })),
        checklist: await sourceChecklist(client, context, context.period),
      };
    });
  }

  async setRequiredSources(context) {
    validateClosePeriod(context.period);
    const ids = context.dataStreamIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      !Number.isInteger(context.expectedVersion) ||
      context.expectedVersion < 0
    )
      throw monthlyCloseError(
        "Select 1–50 required source series and refresh before confirming.",
      );
    ids.forEach(validateCloseId);
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireMember(client, context, CAPABILITIES.WRITE_BUSINESS_DATA);
      await lockPeriod(client, context, context.period);
      const existing = await client.query(
        "select coalesce(max(version),0)::integer as version from monthly_source_sets where organization_id=$1 and period=$2",
        [context.organizationId, context.period],
      );
      if (existing.rows[0].version !== context.expectedVersion)
        throw monthlyCloseError(
          "Source requirements changed. Refresh before confirming.",
          "CONFLICT",
        );
      const owned = await client.query(
        "select id from data_streams where organization_id=$1 and id=any($2::uuid[])",
        [context.organizationId, ids],
      );
      if (owned.rows.length !== ids.length)
        throw monthlyCloseError(
          "A required source was not found.",
          "NOT_FOUND",
        );
      const saved = await client.query(
        "insert into monthly_source_sets(organization_id,period,version,confirmed_by_user_id) values($1,$2,$3,$4) returning id",
        [
          context.organizationId,
          context.period,
          context.expectedVersion + 1,
          context.actorUserId,
        ],
      );
      for (const id of ids)
        await client.query(
          "insert into monthly_required_sources(organization_id,source_set_id,data_stream_id) values($1,$2,$3)",
          [context.organizationId, saved.rows[0].id, id],
        );
      await client.query(
        "insert into audit_events(organization_id,actor_user_id,event_type,target_type,target_id) values($1,$2,'monthly_sources.confirmed','monthly_source_set',$3)",
        [context.organizationId, context.actorUserId, saved.rows[0].id],
      );
      return {
        saved: true,
        checklist: await sourceChecklist(client, context, context.period),
      };
    });
  }

  async list(context) {
    if (context.period !== undefined) validateClosePeriod(context.period);
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireMember(client, context, CAPABILITIES.READ_BUSINESS_DATA);
      const result = await client.query(
        `${SELECT_CLOSE}
        where v.organization_id = $1 and ($2::text is null or v.period = $2)
        order by v.period desc, v.version desc limit 50`,
        [context.organizationId, context.period ?? null],
      );
      const items = [];
      for (const row of result.rows)
        items.push(await readableClose(client, context, row));
      return items;
    });
  }

  async get(context) {
    validateCloseId(context.id);
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireMember(client, context, CAPABILITIES.READ_BUSINESS_DATA);
      return readableClose(
        client,
        context,
        await getRow(client, context, context.id),
      );
    });
  }

  async createDraft(context) {
    const period = validateClosePeriod(context.period);
    const supersedesId =
      context.supersedesId == null
        ? null
        : validateCloseId(context.supersedesId);
    const idempotencyKey = context.idempotencyKey;
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)
    )
      throw monthlyCloseError("A bounded idempotency key is required.");
    // The caller's report contributes selectors only, never financial values.
    canonicalJson(context.report);
    const source = validateCloseId(context.report?.sourceId);
    const metric = context.report?.metric?.column;
    if (typeof metric !== "string" || !metric || metric.length > 160)
      throw monthlyCloseError("Choose a metric available in the source.");
    const dateColumn = context.report?.evidence?.dateColumn ?? null;
    if (
      dateColumn !== null &&
      (typeof dateColumn !== "string" || !dateColumn || dateColumn.length > 160)
    )
      throw monthlyCloseError("Report date field is invalid.");
    const compare = context.report?.previous?.period ?? "none";
    if (compare !== "none") validateClosePeriod(compare);
    const dimension = context.report?.drivers?.column ?? null;
    if (
      dimension !== null &&
      (typeof dimension !== "string" || !dimension || dimension.length > 160)
    )
      throw monthlyCloseError("Report dimension is invalid.");
    const limitations = context.limitations ?? [];
    canonicalJson(limitations);
    if (!Array.isArray(limitations) || limitations.length > 100)
      throw monthlyCloseError("Monthly close limitations are invalid.");
    if (context.evidenceManifest !== undefined)
      canonicalJson(context.evidenceManifest);
    const requestHash = monthlyCloseHash({
      period,
      supersedesId,
      source,
      metric,
      dateColumn,
      compare,
      dimension,
      limitations,
      evidenceManifest: context.evidenceManifest ?? null,
    });

    return withTenantTransaction(this.pool, context, async (client) => {
      const member = await requireMember(
        client,
        context,
        CAPABILITIES.WRITE_BUSINESS_DATA,
        true,
      );
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`monthly-close-key:${context.organizationId}:${idempotencyKey}`],
      );
      const prior = await client.query(
        `${SELECT_CLOSE} where v.organization_id = $1 and v.idempotency_key = $2`,
        [context.organizationId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw monthlyCloseError(
            "This idempotency key belongs to a different monthly close request.",
            "CONFLICT",
          );
        return readableClose(client, context, prior.rows[0]);
      }
      await lockPeriod(client, context, period);
      const active = await activeApproval(client, context, period);
      if ((active?.id ?? null) !== supersedesId)
        throw monthlyCloseError(
          "Name the current approved monthly close explicitly when preparing a correction.",
          "CONFLICT",
        );
      const report = await generateReport(client, context, {
        source,
        metric,
        dateColumn,
        compare,
        dimension,
        period,
      });
      report.evidence.sourceChecklist = await sourceChecklist(
        client,
        context,
        period,
      );
      report.evidence.moneyTrail = await readMoneyTrailSnapshot(client, {
        ...context,
        period,
      });
      const packet = buildMonthlyClosePacket({
        period,
        report,
        limitations,
        supersedesId,
      });
      if (
        context.evidenceManifest !== undefined &&
        canonicalJson(context.evidenceManifest) !==
          canonicalJson(report.evidence) &&
        canonicalJson(context.evidenceManifest) !==
          canonicalJson(packet.evidenceManifest)
      ) {
        throw monthlyCloseError(
          "The evidence manifest changed or does not match the server-built report. Refresh before drafting.",
          "CONFLICT",
        );
      }
      const versionResult = await client.query(
        "select coalesce(max(version), 0) + 1 as version from monthly_close_versions where organization_id = $1 and period = $2",
        [context.organizationId, period],
      );
      const result = await client.query(
        `insert into monthly_close_versions
        (organization_id, period, version, supersedes_id, report, evidence_manifest, limitations,
         canonical_payload, content_hash, idempotency_key, request_hash, created_by_user_id, created_by_name)
        values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13) returning id`,
        [
          context.organizationId,
          period,
          versionResult.rows[0].version,
          supersedesId,
          JSON.stringify(packet.report),
          JSON.stringify(packet.evidenceManifest),
          JSON.stringify(packet.limitations),
          canonicalJson(packet),
          monthlyCloseHash(packet),
          idempotencyKey,
          requestHash,
          context.actorUserId,
          member.display_name,
        ],
      );
      return readableClose(
        client,
        context,
        await getRow(client, context, result.rows[0].id),
      );
    });
  }

  async approve(context) {
    validateCloseId(context.id);
    if (
      !Number.isSafeInteger(context.expectedVersion) ||
      context.expectedVersion < 1
    )
      throw monthlyCloseError("Expected monthly close version is required.");
    return withTenantTransaction(this.pool, context, async (client) => {
      const member = await requireMember(
        client,
        context,
        CAPABILITIES.WRITE_BUSINESS_DATA,
        true,
      );
      if (!["owner", "admin"].includes(member.role))
        throw monthlyCloseError(
          "A named owner or admin must approve the monthly close.",
          "ORG_ACCESS_DENIED",
        );
      const initial = await getRow(client, context, context.id);
      await lockPeriod(client, context, initial.period);
      const row = await getRow(client, context, context.id);
      if (row.version !== context.expectedVersion || row.status !== "draft")
        throw monthlyCloseError(
          "This monthly close changed or was already approved. Refresh before approving.",
          "CONFLICT",
        );
      const packet = verifiedPacket(row);
      const blockers = approvalBlockers(packet);
      const currentChecklist = await sourceChecklist(
        client,
        context,
        row.period,
      );
      if (
        canonicalJson(currentChecklist) !==
        canonicalJson(packet.evidenceManifest.sourceChecklist)
      )
        throw monthlyCloseError(
          "The required sources or import status changed. Prepare a fresh draft.",
          "MONTHLY_CLOSE_NOT_READY",
        );
      const financial = await readMoneyTrailSnapshot(client, {
        ...context,
        period: row.period,
      });
      if (
        canonicalJson({ ...financial, asOf: null }) !==
        canonicalJson({ ...packet.evidenceManifest.moneyTrail, asOf: null })
      )
        throw monthlyCloseError(
          "Reviewed receipts or allocations changed. Prepare a fresh draft before approval.",
          "MONTHLY_CLOSE_NOT_READY",
        );
      if (blockers.length)
        throw monthlyCloseError(
          `Approval requires a confirmed metric definition, nonempty verified metrics and resolved source coverage: ${blockers.join(", ")}.`,
          "MONTHLY_CLOSE_NOT_READY",
        );
      const availability = await sourceAvailability(
        client,
        context,
        packet.evidenceManifest.sources,
        true,
      );
      if (availability !== "available")
        throw monthlyCloseError(
          "Source evidence has changed or is unavailable. Prepare a new draft.",
          "MONTHLY_CLOSE_NOT_READY",
        );
      const active = await activeApproval(client, context, row.period);
      if ((active?.id ?? null) !== row.supersedes_id)
        throw monthlyCloseError(
          "The current approved version changed. Prepare an explicit correction.",
          "CONFLICT",
        );
      await client.query(
        `insert into monthly_close_approvals
        (organization_id, close_id, supersedes_id, approved_by_user_id, approved_by_name, approved_by_role)
        values ($1,$2,$3,$4,$5,$6)`,
        [
          context.organizationId,
          row.id,
          row.supersedes_id,
          context.actorUserId,
          member.display_name,
          member.role,
        ],
      );
      return readableClose(
        client,
        context,
        await getRow(client, context, row.id),
      );
    });
  }
}

async function requireMember(client, context, capability, lock = false) {
  const result = await client.query(
    `select m.role::text, left(u.display_name, 200) as display_name
    from organization_memberships m join app_users u on u.id = m.user_id
    join organizations o on o.id = m.organization_id
    where m.organization_id = $1 and m.user_id = $2 and m.status = 'active'
      and m.disabled_at is null and u.disabled_at is null and o.disabled_at is null ${lock ? "for share of m, u, o" : ""}`,
    [context.organizationId, context.actorUserId],
  );
  const member = result.rows[0];
  if (!ROLE_CAPABILITIES[member?.role]?.includes(capability))
    throw monthlyCloseError("Organization access denied.", "ORG_ACCESS_DENIED");
  return member;
}

async function lockPeriod(client, context, period) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `monthly-close:${context.organizationId}:${period}`,
  ]);
}

async function sourceChecklist(client, context, period) {
  const version = await client.query(
    "select id,version,confirmed_by_user_id,confirmed_at from monthly_source_sets where organization_id=$1 and period=$2 order by version desc limit 1",
    [context.organizationId, period],
  );
  const set = version.rows[0];
  if (!set) return { confirmed: false, version: 0, period, sources: [] };
  const result = await client.query(
    `select ds.id,ds.display_name,ir.id as ingestion_run_id,ir.status,rp.data_status,j.status as processing_status
    from monthly_required_sources s join data_streams ds on ds.id=s.data_stream_id and ds.organization_id=s.organization_id
    left join reporting_periods rp on rp.organization_id=s.organization_id and rp.data_stream_id=s.data_stream_id and rp.period_start=($3||'-01')::date
    left join lateral(select i.id,i.status from ingestion_runs i where i.organization_id=s.organization_id and i.reporting_period_id=rp.id order by i.created_at desc,i.id desc limit 1) ir on true
    left join processing_jobs j on j.organization_id=s.organization_id and j.ingestion_run_id=ir.id
    where s.organization_id=$1 and s.source_set_id=$2 order by ds.id`,
    [context.organizationId, set.id, period],
  );
  return {
    confirmed: true,
    version: set.version,
    period,
    confirmedByUserId: set.confirmed_by_user_id,
    confirmedAt: set.confirmed_at.toISOString(),
    sources: result.rows.map((r) => ({
      streamId: r.id,
      name: r.display_name,
      ingestionRunId: r.ingestion_run_id ?? null,
      status: !r.ingestion_run_id
        ? "missing"
        : r.status === "rejected"
          ? "validation_failed"
          : r.processing_status === "succeeded"
            ? r.data_status === "partial"
              ? "partial"
              : "ready"
            : ["failed", "dead"].includes(r.processing_status)
              ? "processing_failed"
              : "processing",
    })),
  };
}

async function activeApproval(client, context, period) {
  const result = await client.query(
    `${SELECT_CLOSE} where v.organization_id = $1 and v.period = $2
    and a.close_id is not null and next.close_id is null`,
    [context.organizationId, period],
  );
  return result.rows[0] ?? null;
}

async function getRow(client, context, id) {
  const result = await client.query(
    `${SELECT_CLOSE} where v.organization_id = $1 and v.id = $2`,
    [context.organizationId, id],
  );
  if (!result.rows[0])
    throw monthlyCloseError("Monthly close not found.", "NOT_FOUND");
  return result.rows[0];
}

function verifiedPacket(row) {
  const packet = {
    schemaVersion: "biznoryx.monthly-close.v1",
    period: row.period,
    supersedesId: row.supersedes_id,
    report: row.report,
    evidenceManifest: row.evidence_manifest,
    limitations: row.limitations,
  };
  if (
    monthlyCloseHash(packet) !== row.content_hash ||
    canonicalJson(packet) !== row.canonical_payload
  )
    throw monthlyCloseError(
      "Monthly close integrity verification failed.",
      "MONTHLY_CLOSE_INTEGRITY_FAILED",
    );
  return packet;
}

async function readableClose(client, context, row) {
  const packet = verifiedPacket(row);
  return {
    id: row.id,
    organizationId: row.organization_id,
    period: row.period,
    version: row.version,
    status: row.status,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    report: packet.report,
    evidenceManifest: packet.evidenceManifest,
    limitations: packet.limitations,
    contentHash: row.content_hash,
    hashAlgorithm: "SHA-256",
    hashSerialization: "sorted-json-v1",
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    approvedAt: row.approved_at ?? null,
    approvedByUserId: row.approved_by_user_id ?? null,
    approvedByName: row.approved_by_name ?? null,
    approvedByRole: row.approved_by_role ?? null,
    evidenceStatus: await sourceAvailability(
      client,
      context,
      packet.evidenceManifest.sources,
    ),
    approvalBlockers: approvalBlockers(packet),
  };
}

async function sourceAvailability(client, context, sources, lock = false) {
  const result = await client.query(
    `select mp.id, mp.ingestion_run_id, mp.raw_data_object_id, raw.checksum_sha256,
    raw.status as raw_status, ir.status as ingestion_status, mp.value_numeric::text, mp.evidence,
    mp.source_row_count, mp.contributing_row_count
    from verified_metric_points mp
    join ingestion_runs ir on ir.organization_id = mp.organization_id and ir.id = mp.ingestion_run_id
    join raw_data_objects raw on raw.organization_id = mp.organization_id and raw.id = mp.raw_data_object_id
    where mp.organization_id = $1 and mp.id = any($2::uuid[]) ${lock ? "for share of mp, ir, raw" : ""}`,
    [context.organizationId, sources.map((s) => s.metricPointId)],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const originalIds = sources
    .filter((s) => s.originalArtifact)
    .map((s) => s.originalArtifact.id);
  const originals = originalIds.length
    ? await client.query(
        `select id,checksum_sha256,status from raw_data_objects where organization_id=$1 and id=any($2::uuid[]) ${lock ? "for share" : ""}`,
        [context.organizationId, originalIds],
      )
    : { rows: [] };
  const byOriginal = new Map(originals.rows.map((r) => [r.id, r]));
  return sources.every((source) => {
    const row = byId.get(source.metricPointId);
    const original = source.originalArtifact
      ? byOriginal.get(source.originalArtifact.id)
      : null;
    return (
      row &&
      row.ingestion_run_id === source.id &&
      row.raw_data_object_id === source.rawDataObjectId &&
      row.checksum_sha256 === source.checksum &&
      row.ingestion_status !== "rejected" &&
      row.raw_status === "accepted" &&
      (!source.originalArtifact ||
        (original?.status === "accepted" &&
          original.checksum_sha256 === source.originalArtifact.checksum)) &&
      (!source.metricPointHash || source.metricPointHash === pointHash(row))
    );
  })
    ? "available"
    : "unavailable";
}

function pointHash(row) {
  return monthlyCloseHash({
    value: row.value_numeric,
    evidence: row.evidence,
    sourceRows: row.source_row_count,
    contributingRows: row.contributing_row_count,
  });
}

// Bounded equivalent of the existing verified-series read, within the draft's
// own transaction. Retain only the latest ingestion per definition/period.
async function generateReport(client, context, options) {
  const selected = await client.query(
    "select data_stream_id from ingestion_runs where organization_id = $1 and id = $2",
    [context.organizationId, options.source],
  );
  const streamId = selected.rows[0]?.data_stream_id;
  if (!streamId)
    throw monthlyCloseError("Report source not found.", "NOT_FOUND");
  const result = await client.query(
    `with ranked as (
    select md.id as definition_id, md.source_column, md.label, md.unit, ds.display_name,
      mp.id, mp.ingestion_run_id, mp.raw_data_object_id, mp.value_numeric::text, mp.evidence,
      mp.source_row_count, mp.contributing_row_count, mp.created_at, rp.period_start, rp.data_status,
      raw.checksum_sha256, raw.original_filename,
      row_number() over (partition by md.id, rp.id order by ir.created_at desc, mp.created_at desc, mp.id desc) as rank
    from verified_metric_definitions md
    join verified_metric_points mp on mp.organization_id = md.organization_id and mp.metric_definition_id = md.id
    join data_streams ds on ds.organization_id = md.organization_id and ds.id = md.data_stream_id
    join ingestion_runs ir on ir.organization_id = mp.organization_id and ir.id = mp.ingestion_run_id
    join raw_data_objects raw on raw.organization_id = mp.organization_id and raw.id = mp.raw_data_object_id
    join reporting_periods rp on rp.organization_id = mp.organization_id and rp.id = mp.reporting_period_id
    where md.organization_id = $1 and md.data_stream_id = $2 and md.aggregation = 'sum')
    select definition_id, source_column, label, unit, display_name, id, ingestion_run_id, raw_data_object_id,
      value_numeric, evidence, source_row_count, contributing_row_count, created_at, period_start, data_status,
      checksum_sha256, original_filename from ranked where rank = 1 order by period_start, id limit 1501`,
    [context.organizationId, streamId],
  );
  if (result.rows.length > 1500)
    throw monthlyCloseError(
      "This reporting series exceeds the monthly close point budget.",
    );
  const grouped = new Map();
  for (const row of result.rows) {
    const item = grouped.get(row.definition_id) ?? {
      sourceColumn: row.source_column,
      label: row.label,
      unit: row.unit,
      aggregation: "sum",
      dataStream: { id: streamId, displayName: row.display_name },
      points: [],
    };
    item.points.push({
      id: row.id,
      ingestionRunId: row.ingestion_run_id,
      rawDataObjectId: row.raw_data_object_id,
      value: row.value_numeric,
      sourceRowCount: row.source_row_count,
      contributingRowCount: row.contributing_row_count,
      createdAt: row.created_at.toISOString(),
      periodStart: row.period_start,
      dataStatus: row.data_status,
      evidence: {
        ...row.evidence,
        fileName: row.original_filename,
        checksumSha256: row.checksum_sha256,
      },
    });
    grouped.set(row.definition_id, item);
  }
  // Check the aggregate analytics budget before the evidence engine clones it.
  canonicalJson(
    [...grouped.values()].map((item) => ({
      ...item,
      points: item.points.map((point) => ({
        ...point,
        periodStart: String(point.periodStart),
      })),
    })),
  );
  const definitions = await client.query(
    `select distinct on (source_column) source_column, version, label, unit, polarity,
    materiality_percent, approved_by_user_id, approved_at, revenue_breakdown
    from evidence_report_definitions where organization_id = $1 and series_key = $2
    order by source_column, version desc`,
    [context.organizationId, streamId],
  );
  const policies = definitions.rows.map((row) => ({
    seriesKey: streamId,
    column: row.source_column,
    version: row.version,
    label: row.label,
    unit: row.unit,
    polarity: row.polarity,
    materialityPercent: Number(row.materiality_percent),
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at.toISOString(),
    revenueBreakdown: row.revenue_breakdown,
  }));
  const profiles = await client.query(
    "select legal_name, trading_name, primary_currency from business_profiles where organization_id = $1 limit 1",
    [context.organizationId],
  );
  const profile = profiles.rows[0];
  if (!profile?.primary_currency)
    throw monthlyCloseError(
      "Confirm the business reporting currency before preparing a close.",
    );
  const report = buildBusinessReport({
    sources: reportSourcesFromSeries([...grouped.values()]),
    policies,
    profile: {
      legalName: profile.legal_name,
      tradingName: profile.trading_name,
      primaryCurrency: profile.primary_currency,
    },
    options,
  });
  if (!report)
    throw monthlyCloseError(
      "No verified metrics are available for this monthly close.",
    );
  const byPoint = new Map(result.rows.map((row) => [row.id, row]));
  const manifests = await client.query(
    `select m.*,p.version as profile_version,p.definition,r.checksum_sha256 as original_checksum,r.original_filename,r.content_type,r.byte_size
    from ingestion_import_manifests m join raw_data_objects r on r.id=m.original_raw_object_id and r.organization_id=m.organization_id
    left join import_profiles p on p.id=m.profile_id and p.organization_id=m.organization_id
    where m.organization_id=$1 and m.ingestion_run_id=any($2::uuid[])`,
    [context.organizationId, report.evidence.sources.map((s) => s.id)],
  );
  const byRun = new Map(manifests.rows.map((r) => [r.ingestion_run_id, r]));
  report.evidence.importProfiles = [
    ...new Map(
      manifests.rows
        .filter((m) => m.profile_id)
        .map((m) => [
          m.profile_id,
          {
            id: m.profile_id,
            version: m.profile_version,
            definition: m.definition,
          },
        ]),
    ).values(),
  ];
  for (const source of report.evidence.sources) {
    const row = byPoint.get(source.metricPointId);
    source.metricPointHash = pointHash(row);
    source.calculationParserVersion = row.evidence.parserVersion ?? null;
    const manifest = byRun.get(source.id);
    if (manifest) {
      source.originalArtifact = {
        id: manifest.original_raw_object_id,
        checksum: manifest.original_checksum,
        fileName: manifest.original_filename,
        contentType: manifest.content_type,
        byteSize: Number(manifest.byte_size),
      };
      source.parserVersion = manifest.parser_version;
      source.selectedSheet = manifest.selected_sheet;
      source.importProfile = manifest.profile_id
        ? { id: manifest.profile_id, version: manifest.profile_version }
        : null;
      source.normalization = manifest.normalization;
      source.rowLocatorConvention = manifest.row_locator_convention;
    }
    source.schemaFingerprint =
      row.evidence.reportAnalytics?.schemaFingerprint ?? null;
    source.sourceRows = row.source_row_count;
    source.contributingRows = row.contributing_row_count;
    source.excludedRows = row.source_row_count - row.contributing_row_count;
  }
  if (
    (await sourceAvailability(
      client,
      context,
      report.evidence.sources,
      true,
    )) !== "available"
  )
    throw monthlyCloseError(
      "Source evidence is unavailable or changed during generation.",
      "MONTHLY_CLOSE_NOT_READY",
    );
  return report;
}
