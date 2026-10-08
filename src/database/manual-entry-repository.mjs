import { createHash, randomUUID } from "node:crypto";
import { CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import {
  ManualEntryError, SALES_COLUMNS, assertGridLimits, canonicalMonthlyCsv, monthlyPeriod, validateGrid,
} from "../ingestion/manual-entry.mjs";
import { PostgresDataIngestionRepository } from "./data-ingestion-repository.mjs";
import { withTenantTransaction } from "./postgres.mjs";

const DRAFT_FIELDS = "id,organization_id,data_stream_id,period,version,columns,rows,entry_date,correction_of,validated_version,validation_id,created_by_user_id,updated_by_user_id,created_at,updated_at";
const SUBMISSION_FIELDS = "id,organization_id,data_stream_id,draft_id,draft_version,period,batch_id,revision,correction_of,columns,rows,entry_date,snapshot_rows,snapshot_csv,checksum_sha256,file_name,data_status,submitted_by_user_id,submitted_at";
const STREAM_FIELDS = "id,organization_id,data_source_id,name,display_name,grain,expected_schema_fingerprint,active_schema_version_id,created_by_user_id,created_at,updated_at";

function fields(list, alias) { return list.split(",").map((name) => `${alias}.${name}`).join(", "); }

export class PostgresManualEntryRepository {
  constructor(pool) {
    if (!pool) throw new TypeError("PostgreSQL pool is required.");
    this.pool = pool;
    this.ingestion = new PostgresDataIngestionRepository(pool);
  }

  async transaction(input, write, work) {
    identifier(input.organizationId);
    identifier(input.actorUserId);
    try {
      return await withTenantTransaction(this.pool, input, async (client) => {
        await access(client, input, write);
        return work(client);
      });
    } catch (error) {
      if (error.code === "23514" && error.message.includes("SOURCE_MODE_CONFLICT")) {
        throw new ManualEntryError("This series/month already belongs to another input mode. Explicit source resolution is required.", "SOURCE_MODE_CONFLICT");
      }
      throw error;
    }
  }

  async load(input) {
    return this.transaction(input, false, async (client) => {
      const streams = await client.query(
        `select ds.id, ds.name, ds.display_name, ssv.columns from data_streams ds
         left join stream_schema_versions ssv on ssv.id = ds.active_schema_version_id
         where ds.organization_id = $1 and ds.grain = 'monthly' order by ds.display_name, ds.id`,
        [input.organizationId],
      );
      const saved = await client.query(
        `select ${fields(DRAFT_FIELDS.split(",").filter((field) => field !== "rows").join(","), "d")}, ds.display_name from manual_entry_drafts d
         join data_streams ds on ds.id = d.data_stream_id
         where d.organization_id = $1 and not exists (
           select 1 from manual_entry_submissions s join manual_entry_deliveries delivery on delivery.submission_id = s.id
           where s.organization_id = d.organization_id and s.draft_id = d.id and delivery.ingestion_run_id is not null
         ) order by d.updated_at desc, d.id limit 100`, [input.organizationId],
      );
      const result = {
        drafts: saved.rows.map(mapDraft),
        series: streams.rows.map((row) => ({ id: row.id, name: row.display_name, columns: row.columns ?? SALES_COLUMNS })),
        template: { name: "Sales", columns: SALES_COLUMNS, rows: [], dataStatus: "partial" },
      };
      const submissions = await client.query(
        `select ${fields(SUBMISSION_FIELDS.split(",").filter((field) => !["rows", "columns", "snapshot_rows", "snapshot_csv"].includes(field)).join(","), "s")},
         jsonb_array_length(s.rows) as row_count, jsonb_array_length(s.snapshot_rows) as snapshot_row_count,
         ds.display_name, delivery.ingestion_run_id, delivery.upload->'reportingPeriod'->>'id' as reporting_period_id
         from manual_entry_submissions s join data_streams ds on ds.id = s.data_stream_id
         left join manual_entry_deliveries delivery on delivery.submission_id = s.id
         where s.organization_id = $1 and not exists (select 1 from manual_entry_submissions newer
           where newer.organization_id = s.organization_id and newer.batch_id = s.batch_id and newer.revision > s.revision)
         order by s.submitted_at desc, s.id limit 100`, [input.organizationId],
      );
      result.submissions = submissions.rows.map((row) => {
        const { rows, columns, ...summary } = mapSubmission(row);
        return summary;
      });
      if (input.submissionId) {
        identifier(input.submissionId);
        const selected = await client.query(
          `select ${fields(SUBMISSION_FIELDS, "s")}, ds.display_name, delivery.ingestion_run_id, delivery.upload->'reportingPeriod'->>'id' as reporting_period_id
           from manual_entry_submissions s join data_streams ds on ds.id = s.data_stream_id
           left join manual_entry_deliveries delivery on delivery.submission_id = s.id
           where s.organization_id = $1 and s.id = $2`, [input.organizationId, input.submissionId],
        );
        if (!selected.rows[0]) throw new ManualEntryError("Submission not found.", "MANUAL_NOT_FOUND");
        result.submission = mapSubmission(selected.rows[0]);
      }
      if (input.draftId) result.draft = mapDraft(await draft(client, input, input.draftId));
      else if (input.dataSeries || input.period) {
        const period = monthlyPeriod(input.period).label;
        const series = await resolveSeries(client, input, false);
        result.draft = {
          id: null, version: 0, dataSeries: series.display_name, dataStreamId: series.id ?? null,
          period, columns: series.columns, rows: [], entryDate: null, correctionOf: null, dataStatus: "partial",
        };
      }
      return result;
    });
  }

  async saveDraft(input) {
    monthlyPeriod(input.period);
    const expectedVersion = version(input.version ?? (input.id ? null : 0), Boolean(input.id));
    if (input.entryDate != null && (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate) ||
        !Number.isFinite(Date.parse(`${input.entryDate}T00:00:00Z`)) ||
        new Date(`${input.entryDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.entryDate ||
        !input.entryDate.startsWith(`${input.period}-`))) throw new ManualEntryError("entryDate must be a real date within this month.");
    return this.transaction(input, true, async (client) => {
      // The same lock serializes stream establishment across drafts and uploads.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.organizationId}:manual-series`]);
      const series = await resolveSeries(client, input, true);
      const canonicalRows = alignGrid(input.columns, input.rows, series.columns);
      const previous = input.id ? await draft(client, input, input.id, true) : null;
      if (previous) {
        if (previous.version !== expectedVersion) throw new ManualEntryError("Draft changed. Reload before saving.", "DRAFT_VERSION_CONFLICT");
        if (previous.data_stream_id !== series.id || previous.period !== input.period ||
            (previous.correction_of ?? null) !== (input.correctionOf ?? null)) {
          throw new ManualEntryError("A saved draft cannot change series, month or correction target.");
        }
        const submitted = await client.query("select 1 from manual_entry_submissions where organization_id = $1 and draft_id = $2 limit 1", [input.organizationId, input.id]);
        if (submitted.rowCount) throw new ManualEntryError("Submitted drafts are immutable. Create a new correction draft.", "DRAFT_ALREADY_SUBMITTED");
      }
      if (input.correctionOf) await correction(client, input, series.id, input.correctionOf);
      const id = previous?.id ?? randomUUID();
      const params = [id, input.organizationId, series.id, input.period, JSON.stringify(series.columns),
        JSON.stringify(canonicalRows), input.entryDate ?? null, input.correctionOf ?? null, input.actorUserId];
      const saved = previous
        ? await client.query(
          `update manual_entry_drafts set version = version + 1, data_stream_id = $3, period = $4,
           columns = $5::jsonb, rows = $6::jsonb, correction_of = $8,
           entry_date = $7, validated_version = null, validation_id = null,
           updated_by_user_id = $9, updated_at = now() where id = $1 and organization_id = $2 returning ${DRAFT_FIELDS}`, params,
        )
        : await client.query(
          `insert into manual_entry_drafts(id, organization_id, data_stream_id, period, columns, rows, entry_date,
           correction_of, created_by_user_id, updated_by_user_id)
           values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$9) returning ${DRAFT_FIELDS}`, params,
        );
      await audit(client, input, "manual_entry.draft_saved", id);
      return { draft: mapDraft({ ...saved.rows[0], display_name: series.display_name }) };
    });
  }

  async validateDraft(input) {
    version(input.version, true);
    return this.transaction(input, true, async (client) => {
      const current = await draft(client, input, input.draftId, true);
      assertVersion(current, input.version);
      const series = await ownedSeries(client, input, current.data_stream_id);
      assertSchema(current.columns, series.columns);
      const validated = validateGrid({ ...mapDraft(current) });
      const validationId = validated.valid
        ? (current.validated_version === current.version ? current.validation_id : null) ?? randomUUID() : null;
      await client.query(
        `update manual_entry_drafts set validated_version = $3, validation_id = $4 where organization_id = $1 and id = $2`,
        [input.organizationId, current.id, validated.valid ? current.version : null, validationId],
      );
      return { valid: validated.valid, issues: validated.issues, rowCount: validated.rowCount,
        validationId, draftId: current.id, version: current.version, dataStatus: "partial" };
    });
  }

  async prepareSubmission(input) {
    version(input.version, true);
    return this.transaction(input, true, async (client) => {
      const current = await draft(client, input, input.draftId, true);
      assertVersion(current, input.version);
      if (!input.validationId || input.validationId !== current.validation_id || current.validated_version !== current.version) {
        throw new ManualEntryError("Use the validationId returned for this saved draft version.", "DRAFT_NOT_VALIDATED");
      }
      await periodLock(client, input, current);
      const retry = await client.query(
        `select ${SUBMISSION_FIELDS} from manual_entry_submissions where organization_id = $1 and draft_id = $2 and draft_version = $3`,
        [input.organizationId, current.id, current.version],
      );
      if (retry.rows[0]) return this.result(client, current, retry.rows[0], true);
      if (current.validated_version !== current.version || !current.validation_id) {
        throw new ManualEntryError("Validate this saved draft version before submitting.", "DRAFT_NOT_VALIDATED");
      }
      const series = await ownedSeries(client, input, current.data_stream_id, true);
      assertSchema(current.columns, series.columns);
      const validation = validateGrid(mapDraft(current));
      if (!validation.valid) throw new ManualEntryError("Draft contains invalid cells.", "VALIDATION_FAILED", validation.issues);
      await client.query("select claim_ingestion_period_source($1,$2,$3,'manual_entry')", [input.organizationId, current.data_stream_id, current.period]);
      const latest = await client.query(
        `select distinct on (s.batch_id) ${fields(SUBMISSION_FIELDS, "s")}, delivery.ingestion_run_id, jobs.status as processing_status
         from manual_entry_submissions s left join manual_entry_deliveries delivery on delivery.submission_id = s.id
         left join processing_jobs jobs on jobs.ingestion_run_id = delivery.ingestion_run_id
           and jobs.job_type = 'ingestion.verify_storage'
         where s.organization_id = $1 and s.data_stream_id = $2 and s.period = $3
         order by s.batch_id, s.revision desc`,
        [input.organizationId, current.data_stream_id, current.period],
      );
      if (latest.rows.some((row) => row.processing_status !== "succeeded")) {
        throw new ManualEntryError("The previous monthly snapshot must finish processing before another submission. Retry its draft if delivery failed.", "MANUAL_PROCESSING_PENDING");
      }
      const target = current.correction_of
        ? await correction(client, { ...input, period: current.period }, current.data_stream_id, current.correction_of) : null;
      const id = randomUUID();
      const batchId = target?.batch_id ?? id;
      const ledger = latest.rows.filter((row) => row.batch_id !== batchId)
        .map((row) => ({ batchId: row.batch_id, rows: row.rows }));
      ledger.push({ batchId, rows: validation.normalizedRows });
      ledger.sort((a, b) => a.batchId.localeCompare(b.batchId));
      const snapshotRows = ledger.flatMap((batch) => batch.rows);
      const csv = canonicalMonthlyCsv(current.columns, snapshotRows);
      const checksum = createHash("sha256").update(csv, "utf8").digest("hex");
      const saved = await client.query(
        `insert into manual_entry_submissions(id, organization_id, data_stream_id, draft_id, draft_version,
         period, batch_id, revision, correction_of, columns, rows, entry_date, snapshot_rows,
         snapshot_csv, checksum_sha256, file_name, submitted_by_user_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17) returning ${SUBMISSION_FIELDS}`,
        [id, input.organizationId, current.data_stream_id, current.id, current.version, current.period,
          batchId, (target?.revision ?? 0) + 1, target?.id ?? null, JSON.stringify(current.columns),
          JSON.stringify(validation.normalizedRows), current.entry_date, JSON.stringify(snapshotRows), csv,
          checksum, `manual-${current.data_stream_id}-${current.period}.csv`, input.actorUserId],
      );
      await client.query("insert into manual_entry_deliveries(submission_id, organization_id) values($1,$2)", [id, input.organizationId]);
      await audit(client, input, "manual_entry.submitted", id);
      return this.result(client, current, saved.rows[0], true);
    });
  }

  async finalizeSubmission(input) {
    version(input.version, true);
    return this.transaction(input, true, async (client) => {
      const current = await draft(client, input, input.draftId, true);
      assertVersion(current, input.version);
      await periodLock(client, input, current);
      identifier(input.submissionId);
      const saved = await client.query(
        `select ${SUBMISSION_FIELDS} from manual_entry_submissions where organization_id = $1 and id = $2
         and draft_id = $3 and draft_version = $4`,
        [input.organizationId, input.submissionId, current.id, current.version],
      );
      const submission = saved.rows[0];
      if (!submission) throw new ManualEntryError("Submission not found.", "MANUAL_NOT_FOUND");
      const retry = await this.result(client, current, submission);
      if (retry.upload) return retry;
      const series = await ownedSeries(client, input, current.data_stream_id, true);
      assertSchema(submission.columns, series.columns);
      const upload = await this.ingestion.registerManualSnapshot({
        client, organizationId: input.organizationId, actorUserId: input.actorUserId,
        dataSourceId: series.data_source_id, dataStreamId: series.id, manualSubmissionId: submission.id,
        reportingPeriod: monthlyPeriod(submission.period),
        upload: { originalFilename: submission.file_name, contentType: "text/csv", content: submission.snapshot_csv,
          byteSize: Buffer.byteLength(submission.snapshot_csv, "utf8"), rowCount: submission.snapshot_rows.length,
          columns: submission.columns },
      });
      if (upload.ingestionRun.status !== "validated") throw new ManualEntryError("Snapshot schema was rejected. Delivery rolled back.", "MANUAL_SCHEMA_CONFLICT");
      upload.ingestionRun.dataStatus = "partial";
      upload.ingestionRun.manualSubmissionId = submission.id;
      upload.reportingPeriod.dataStatus = "partial";
      await client.query(
        `update manual_entry_deliveries set ingestion_run_id = $3, upload = $4::jsonb, delivered_at = now()
         where organization_id = $1 and submission_id = $2`,
        [input.organizationId, submission.id, upload.ingestionRun.id, JSON.stringify(upload)],
      );
      await audit(client, input, "manual_entry.delivered", submission.id);
      return this.result(client, current, submission);
    });
  }

  async result(client, current, submission, includeSnapshot = false) {
    const delivered = await client.query("select upload from manual_entry_deliveries where organization_id = $1 and submission_id = $2", [submission.organization_id, submission.id]);
    const upload = delivered.rows[0]?.upload ?? null;
    return { draft: mapDraft(current), submission: mapSubmission({ ...submission, display_name: current.display_name,
      ingestion_run_id: upload?.ingestionRun?.id, reporting_period_id: upload?.reportingPeriod?.id }, includeSnapshot && !upload), upload };
  }
}

async function access(client, input, write) {
  const member = await client.query(
    `select m.role from organization_memberships m join organizations o on o.id = m.organization_id
     join app_users u on u.id = m.user_id where m.organization_id = $1 and m.user_id = $2
     and m.status = 'active' and o.disabled_at is null and u.disabled_at is null`,
    [input.organizationId, input.actorUserId],
  );
  if (!member.rows[0]) throw new ManualEntryError("Active organization membership is required.", "ORG_ACCESS_DENIED");
  const capability = write ? CAPABILITIES.WRITE_BUSINESS_DATA : CAPABILITIES.READ_BUSINESS_DATA;
  if (!(ROLE_CAPABILITIES[member.rows[0].role] ?? []).includes(capability)) throw new ManualEntryError(`Capability required: ${capability}`, "CAPABILITY_DENIED");
}

async function resolveSeries(client, input, create) {
  if (input.dataStreamId) return ownedSeries(client, input, input.dataStreamId);
  const name = input.dataSeries ?? "Sales";
  if (typeof name !== "string" || !name.trim() || name.length > 180) throw new ManualEntryError("Data series name is required (maximum 180 characters).");
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new ManualEntryError("Data series name must contain letters or digits.");
  const found = await client.query(
    `select ${fields(STREAM_FIELDS, "ds")} from data_streams ds join data_sources source on source.id = ds.data_source_id
     where ds.organization_id = $1 and source.source_type = 'manual_upload' and source.name = 'Manual uploads'
       and ds.name = $2`, [input.organizationId, slug],
  );
  if (found.rows[0]) return ownedSeries(client, input, found.rows[0].id);
  if (!create) return { display_name: name.trim(), columns: SALES_COLUMNS };
  const source = await client.query(
    `insert into data_sources(organization_id,name,source_type,description,created_by_user_id)
     values($1,'Manual uploads','manual_upload','Files uploaded directly through BIZNORYX.',$2)
     on conflict(organization_id,name) do update set name = excluded.name returning id, source_type`,
    [input.organizationId, input.actorUserId],
  );
  if (source.rows[0].source_type !== "manual_upload") throw new ManualEntryError("Manual uploads source has an incompatible type.");
  const stream = await client.query(
    `insert into data_streams(organization_id,data_source_id,name,display_name,grain,created_by_user_id)
     values($1,$2,$3,$4,'monthly',$5) on conflict(organization_id,data_source_id,name)
     do update set name = excluded.name returning ${STREAM_FIELDS}`,
    [input.organizationId, source.rows[0].id, slug, name.trim(), input.actorUserId],
  );
  return { ...stream.rows[0], columns: SALES_COLUMNS };
}

async function ownedSeries(client, input, id, lock = false) {
  identifier(id);
  const found = await client.query(
    `select ${fields(STREAM_FIELDS, "ds")} from data_streams ds where ds.organization_id = $1 and ds.id = $2 ${lock ? "for update" : ""}`,
    [input.organizationId, id],
  );
  const row = found.rows[0];
  if (!row || row.grain !== "monthly") throw new ManualEntryError("Monthly data series not found.", "MANUAL_NOT_FOUND");
  const schema = row.active_schema_version_id ? await client.query(
    "select columns from stream_schema_versions where organization_id = $1 and id = $2 and data_stream_id = $3",
    [input.organizationId, row.active_schema_version_id, id],
  ) : await client.query(
    "select columns from manual_entry_drafts where organization_id = $1 and data_stream_id = $2 order by created_at, id limit 1",
    [input.organizationId, id],
  );
  return { ...row, columns: schema.rows[0]?.columns ?? SALES_COLUMNS };
}

async function draft(client, input, id, lock = false) {
  identifier(id);
  const found = await client.query(
    `select ${fields(DRAFT_FIELDS, "d")}, ds.display_name from manual_entry_drafts d join data_streams ds on ds.id = d.data_stream_id
     where d.organization_id = $1 and d.id = $2 ${lock ? "for update of d" : ""}`, [input.organizationId, id],
  );
  if (!found.rows[0]) throw new ManualEntryError("Draft not found.", "MANUAL_NOT_FOUND");
  return found.rows[0];
}

async function correction(client, input, streamId, id) {
  identifier(id);
  const found = await client.query(
    `select ${SUBMISSION_FIELDS} from manual_entry_submissions where organization_id = $1 and id = $2 and data_stream_id = $3 and period = $4`,
    [input.organizationId, id, streamId, input.period],
  );
  const target = found.rows[0];
  if (!target) throw new ManualEntryError("Correction target must belong to this series/month.", "MANUAL_NOT_FOUND");
  const newer = await client.query("select 1 from manual_entry_submissions where organization_id = $1 and batch_id = $2 and revision > $3 limit 1", [input.organizationId, target.batch_id, target.revision]);
  if (newer.rowCount) throw new ManualEntryError("This batch has a newer revision. Correct its latest submission.", "CORRECTION_VERSION_CONFLICT");
  return target;
}

async function periodLock(client, input, current) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.organizationId}:${current.data_stream_id}:${current.period}`]);
}

function assertSchema(columns, expected) {
  if (columns == null) return;
  if (!Array.isArray(columns) || columns.length !== expected.length || columns.some((column, index) =>
    column?.name !== expected[index].name || column?.type !== expected[index].type ||
    (column.required != null && column.required !== expected[index].required))) {
    throw new ManualEntryError("Columns changed or do not match the series schema. Reload and confirm mappings.", "MANUAL_SCHEMA_CONFLICT");
  }
}

function alignGrid(columns, rows, expected) {
  if (columns == null) {
    assertGridLimits(rows, expected);
    return rows;
  }
  if (!Array.isArray(columns)) throw new ManualEntryError("Columns must be an array.", "MANUAL_SCHEMA_CONFLICT");
  const indexes = expected.map((column) => columns.findIndex((supplied) => supplied?.name === column.name));
  if (columns.length !== expected.length || new Set(columns.map((column) => column?.name)).size !== expected.length || indexes.includes(-1)) {
    throw new ManualEntryError("Columns must match the series schema by name.", "MANUAL_SCHEMA_CONFLICT");
  }
  assertSchema(indexes.map((index) => columns[index]), expected);
  assertGridLimits(rows, columns);
  return rows.map((row) => indexes.map((index) => row[index]));
}

function assertVersion(current, expected) {
  if (current.version !== expected) throw new ManualEntryError("Draft changed. Reload before continuing.", "DRAFT_VERSION_CONFLICT");
}

function version(value, existing) {
  if (!Number.isSafeInteger(value) || value < (existing ? 1 : 0) || value > 2147483646 || (!existing && value !== 0)) throw new ManualEntryError("A valid optimistic draft version is required.");
  return value;
}

function identifier(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new ManualEntryError("A valid UUID is required.");
}

function dateString(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : value; }

function mapDraft(row) {
  return { id: row.id, version: row.version, dataStreamId: row.data_stream_id, dataSeries: row.display_name,
    period: row.period, columns: row.columns, rows: row.rows, entryDate: dateString(row.entry_date) ?? null,
    correctionOf: row.correction_of, validatedVersion: row.validated_version, validationId: row.validation_id,
    createdByUserId: row.created_by_user_id, updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at, dataStatus: "partial" };
}

function mapSubmission(row, includeSnapshot = false) {
  return { id: row.id, organizationId: row.organization_id, dataStreamId: row.data_stream_id, dataSeries: row.display_name,
    draftId: row.draft_id, version: row.draft_version, period: row.period, batchId: row.batch_id,
    revision: row.revision, correctionOf: row.correction_of, rows: row.rows, columns: row.columns,
    entryDate: dateString(row.entry_date), rowCount: row.row_count ?? row.rows?.length, snapshotRowCount: row.snapshot_row_count ?? row.snapshot_rows?.length,
    ingestionRunId: row.ingestion_run_id ?? null, reportingPeriodId: row.reporting_period_id ?? null,
    checksumSha256: row.checksum_sha256, fileName: row.file_name,
    submittedByUserId: row.submitted_by_user_id, submittedAt: row.submitted_at, dataStatus: row.data_status,
    ...(includeSnapshot ? { snapshotCsv: row.snapshot_csv } : {}) };
}

async function audit(client, input, event, id) {
  await client.query(
    "insert into audit_events(organization_id,actor_user_id,event_type,target_type,target_id) values($1,$2,$3,'manual_entry',$4)",
    [input.organizationId, input.actorUserId, event, id],
  );
}
