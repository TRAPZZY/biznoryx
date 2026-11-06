import { AuthError, CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import { withTenantTransaction } from "./postgres.mjs";

export class PostgresImportManifestRepository {
  constructor(pool) {
    this.pool = pool;
  }
  async get(context) {
    if (!uuid(context.profileId)) invalid("Choose an approved import mapping.");
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireImportAccess(client, context, true);
      const result = await client.query(
        "select id,organization_id,data_stream_id,version,definition,approved_by_user_id,approved_at from import_profiles where organization_id=$1 and id=$2",
        [context.organizationId, context.profileId],
      );
      if (!result.rows[0])
        throw new AuthError("Import mapping not found.", "NOT_FOUND");
      const profile = mapProfile(result.rows[0]);
      profile.definition = validateImportProfile(profile.definition);
      return profile;
    });
  }
  async existingOriginal({
    organizationId, actorUserId, checksumSha256,
  }) {
    if (!/^[a-f0-9]{64}$/.test(String(checksumSha256))) {
      invalid("Invalid original evidence checksum.");
    }

    const context = { organizationId, actorUserId };

    return withTenantTransaction(this.pool, context, async client => {
      await requireImportAccess(client, context, true);

      const result = await client.query(
        `select storage_key from raw_data_objects
         where organization_id = $1
           and checksum_sha256 = $2
           and status = 'accepted'
         limit 1`,
        [organizationId, checksumSha256],
      );

      return result.rows[0]?.storage_key ?? null;
    });
  }

  async available() {
    const result = await this.pool.query(
      "select to_regclass('public.ingestion_import_manifests') is not null and to_regclass('public.import_profiles') is not null as available",
    );
    return result.rows[0].available;
  }
  async list(context) {
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireImportAccess(client, context, false);
      const result = await client.query(
        `select distinct on (p.data_stream_id) p.*, ds.display_name
        from import_profiles p join data_streams ds on ds.id=p.data_stream_id and ds.organization_id=p.organization_id
        where p.organization_id=$1 order by p.data_stream_id,p.version desc`,
        [context.organizationId],
      );
      return result.rows.map(mapProfile);
    });
  }
  async approve(context) {
    const definition = validateImportProfile(context.definition);
    const expected = context.expectedVersion ?? 0;
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      !uuid(context.dataStreamId)
    )
      invalid("Refresh the import mapping before saving.");
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireImportAccess(client, context, true);
      const stream = await client.query(
        "select id from data_streams where organization_id=$1 and id=$2 for update",
        [context.organizationId, context.dataStreamId],
      );
      if (!stream.rows.length)
        throw new AuthError("Data series not found.", "NOT_FOUND");
      const latest = await client.query(
        "select coalesce(max(version),0)::integer as version from import_profiles where organization_id=$1 and data_stream_id=$2",
        [context.organizationId, context.dataStreamId],
      );
      if (latest.rows[0].version !== expected)
        invalid("The mapping changed. Refresh before approving.");
      if (definition.sourceRole !== "other") {
        const business = await client.query(
          "select primary_currency from business_profiles where organization_id=$1",
          [context.organizationId],
        );
        if (business.rows[0]?.primary_currency !== definition.currency)
          invalid(
            "The source currency must match the confirmed business reporting currency. No currency conversion is performed.",
          );
      }
      if (expected > 0) {
        const previous = await client.query(
          "select definition from import_profiles where organization_id=$1 and data_stream_id=$2 order by version desc limit 1",
          [context.organizationId, context.dataStreamId],
        );
        const prior = previous.rows[0].definition;
        if (
          prior.currency !== definition.currency ||
          (prior.sourceRole !== "other" &&
            prior.sourceRole !== definition.sourceRole)
        )
          invalid(
            "The source role or currency changed. Use a separate reporting series to preserve historical meaning.",
          );
      }
      const result = await client.query(
        `insert into import_profiles(organization_id,data_stream_id,version,definition,approved_by_user_id)
        values($1,$2,$3,$4::jsonb,$5) returning *`,
        [
          context.organizationId,
          context.dataStreamId,
          expected + 1,
          JSON.stringify(definition),
          context.actorUserId,
        ],
      );
      await client.query(
        `insert into audit_events(organization_id,actor_user_id,event_type,target_type,target_id)
        values($1,$2,'import_profile.approved','import_profile',$3)`,
        [context.organizationId, context.actorUserId, result.rows[0].id],
      );
      return mapProfile(result.rows[0]);
    });
  }
  async source(context) {
    if (!uuid(context.uploadId))
      throw new AuthError("Upload not found.", "NOT_FOUND");
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireImportAccess(client, context, false);
      const result = await client.query(
        `select m.*,p.definition,p.version as profile_version,r.checksum_sha256 as original_checksum,r.storage_key as original_storage_key
        from ingestion_import_manifests m join import_profiles p on p.id=m.profile_id and p.organization_id=m.organization_id
        join raw_data_objects r on r.id=m.original_raw_object_id and r.organization_id=m.organization_id
        where m.organization_id=$1 and m.ingestion_run_id=$2`,
        [context.organizationId, context.uploadId],
      );
      if (!result.rows[0])
        throw new AuthError(
          "Review and import this source with an approved mapping first.",
          "VALIDATION_FAILED",
        );
      return result.rows[0];
    });
  }
  async attachExisting(context) {
    if (!uuid(context.uploadId) || !uuid(context.profileId))
      invalid("Choose the source and approved mapping.");
    return withTenantTransaction(this.pool, context, async (client) => {
      await requireImportAccess(client, context, true);
      const run = await client.query(
        `select ir.*,r.storage_key,r.original_filename,r.content_type,r.byte_size,r.checksum_sha256,r.status as raw_status
        from ingestion_runs ir join raw_data_objects r on r.id=ir.raw_data_object_id and r.organization_id=ir.organization_id
        where ir.organization_id=$1 and ir.id=$2 for share of ir,r`,
        [context.organizationId, context.uploadId],
      );
      const row = run.rows[0];
      if (
        !row ||
        row.status !== "validated" ||
        row.raw_status !== "accepted" ||
        row.content_type !== "text/csv" ||
        row.checksum_sha256 !== context.reviewedChecksum
      )
        invalid("The validated source changed or is unavailable.");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`import-source:${context.organizationId}:${context.uploadId}`],
      );
      const prior = await client.query(
        "select profile_id from ingestion_import_manifests where organization_id=$1 and ingestion_run_id=$2",
        [context.organizationId, context.uploadId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].profile_id !== context.profileId)
          invalid(
            "This source already has a frozen mapping. A correction must use a new source version.",
          );
        return { saved: true };
      }
      await persistImportManifest(
        client,
        {
          ...context,
          dataStreamId: row.data_stream_id,
          reportingPeriodId: row.reporting_period_id,
        },
        row.id,
        row.raw_data_object_id,
        {
          original: {
            storageKey: row.storage_key,
            originalFilename: row.original_filename,
            contentType: row.content_type,
            byteSize: Number(row.byte_size),
            checksumSha256: row.checksum_sha256,
          },
          profileId: context.profileId,
          parserVersion: context.parserVersion,
          format: "csv",
          columns: context.columns,
        },
      );
      return { saved: true };
    });
  }
}

export function validateImportProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("An import mapping is required.");
  const roles = [
    "sales",
    "receipts",
    "expenses",
    "supplier_purchases",
    "bank_transactions",
    "other",
  ];
  if (!roles.includes(value.sourceRole))
    invalid("Choose the meaning of these records.");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency))
    invalid("Confirm the source currency using its three-letter code.");
  if (!["ISO", "DMY", "MDY"].includes(value.dateConvention))
    invalid("Choose the date convention.");
  if (
    !Array.isArray(value.columns) ||
    value.columns.length < 1 ||
    value.columns.length > 200 ||
    value.columns.some(
      (x) => typeof x !== "string" || !x.trim() || x.length > 160,
    ) ||
    new Set(value.columns).size !== value.columns.length
  )
    invalid("The source column names are invalid.");
  const mapping = {};
  for (const key of ["date", "amount", "reference", "description", "dueDate"]) {
    const name = value.mapping?.[key];
    if (name !== undefined && name !== "" && name !== null) {
      if (!value.columns.includes(name))
        invalid(`The ${key} column is missing. Review the mapping.`);
      mapping[key] = name;
    }
  }
  if (
    ["sales", "receipts"].includes(value.sourceRole) &&
    (!mapping.date || !mapping.amount)
  )
    invalid("Sales and receipts require date and amount columns.");
  const units = {};
  for (const [name, unit] of Object.entries(value.units ?? {})) {
    if (
      !value.columns.includes(name) ||
      typeof unit !== "string" ||
      !unit.trim() ||
      unit.length > 40
    )
      invalid("The column unit is invalid.");
    units[name] = unit.trim();
  }
  return {
    sourceRole: value.sourceRole,
    currency: value.currency,
    dateConvention: value.dateConvention,
    columns: [...value.columns],
    mapping,
    units,
  };
}

// Called inside the ingestion registration transaction, never after commit.
export async function persistImportManifest(
  client,
  context,
  ingestionRunId,
  normalizedRawId,
  manifest,
) {
  const original = manifest.original;
  if (
    !original ||
    !/^[a-f0-9]{64}$/.test(original.checksumSha256) ||
    ![
      `organizations/${context.organizationId}/uploads/`,
      `org/${context.organizationId}/raw/`,
    ].some((prefix) => original.storageKey?.startsWith(prefix)) ||
    !Number.isSafeInteger(original.byteSize) ||
    original.byteSize <= 0 ||
    original.byteSize > 25 * 1024 * 1024 ||
    typeof manifest.parserVersion !== "string" ||
    manifest.parserVersion.length > 120
  )
    invalid("Source evidence is invalid.");
  let originalId = normalizedRawId;
  const raw = await client.query(
    `insert into raw_data_objects(organization_id,storage_key,original_filename,content_type,byte_size,checksum_sha256,status,created_by_user_id)
    values($1,$2,$3,$4,$5,$6,'accepted',$7) on conflict(organization_id,checksum_sha256) do nothing returning id`,
    [
      context.organizationId,
      original.storageKey,
      original.originalFilename,
      original.contentType,
      original.byteSize,
      original.checksumSha256,
      context.actorUserId,
    ],
  );
  if (raw.rows.length) originalId = raw.rows[0].id;
  else {
    const found = await client.query(
      "select id,status from raw_data_objects where organization_id=$1 and checksum_sha256=$2",
      [context.organizationId, original.checksumSha256],
    );
    if (!found.rows.length || found.rows[0].status === "quarantined")
      invalid("Original evidence is unavailable.");
    originalId = found.rows[0].id;
  }
  let profileId = null;
  if (manifest.profileId) {
    if (!uuid(manifest.profileId)) invalid("Import mapping not found.");
    const profile = await client.query(
      `select id,definition from import_profiles where organization_id=$1 and id=$2 and data_stream_id=$3`,
      [context.organizationId, manifest.profileId, context.dataStreamId],
    );
    if (!profile.rows.length)
      invalid("Import mapping does not belong to this data series.");
    if (
      JSON.stringify(profile.rows[0].definition.columns) !==
      JSON.stringify(manifest.columns)
    )
      invalid("Columns changed. Approve a new mapping before importing.");
    profileId = manifest.profileId;
  }
  if (manifest.supersedesRunId) {
    if (!uuid(manifest.supersedesRunId))
      invalid("The corrected upload was not found.");
    const prior = await client.query(
      `select id from ingestion_runs where organization_id=$1 and id=$2 and data_stream_id=$3 and reporting_period_id=$4 and status<>'rejected'`,
      [
        context.organizationId,
        manifest.supersedesRunId,
        context.dataStreamId,
        context.reportingPeriodId,
      ],
    );
    if (!prior.rows.length)
      invalid(
        "A correction must replace an upload in the same data series and month.",
      );
  }
  await client.query(
    `insert into ingestion_import_manifests(organization_id,ingestion_run_id,original_raw_object_id,profile_id,parser_version,selected_sheet,source_format,supersedes_run_id,reviewed_by_user_id,normalization)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      context.organizationId,
      ingestionRunId,
      originalId,
      profileId,
      manifest.parserVersion,
      manifest.selectedSheet ?? null,
      manifest.format,
      manifest.supersedesRunId ?? null,
      context.actorUserId,
      JSON.stringify(manifest.normalization ?? {}),
    ],
  );
}

export async function requireImportAccess(client, context, write) {
  const r = await client.query(
    `select m.role from organization_memberships m join organizations o on o.id=m.organization_id and o.disabled_at is null
    join app_users u on u.id=m.user_id and u.disabled_at is null
    where m.organization_id=$1 and m.user_id=$2 and m.status='active' and m.disabled_at is null`,
    [context.organizationId, context.actorUserId],
  );
  if (
    !ROLE_CAPABILITIES[r.rows[0]?.role]?.includes(
      write
        ? CAPABILITIES.WRITE_BUSINESS_DATA
        : CAPABILITIES.READ_BUSINESS_DATA,
    )
  )
    throw new AuthError("Business access denied.", "ORG_ACCESS_DENIED");
}
function mapProfile(r) {
  return {
    id: r.id,
    dataStreamId: r.data_stream_id,
    dataSeries: r.display_name,
    version: r.version,
    definition: r.definition,
    approvedAt: r.approved_at,
    approvedByUserId: r.approved_by_user_id,
  };
}
function uuid(v) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v));
}
function invalid(message) {
  throw new AuthError(message, "VALIDATION_FAILED");
}
