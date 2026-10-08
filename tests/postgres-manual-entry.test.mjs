import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { parse } from "csv-parse/sync";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresManualEntryRepository } from "../src/database/manual-entry-repository.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { PostgresProcessingJobRepository } from "../src/database/processing-job-repository.mjs";
import { PostgresVerifiedMetricsRepository } from "../src/database/verified-metrics-repository.mjs";
import { PostgresMetricComparisonRepository } from "../src/database/metric-comparison-repository.mjs";
import { withTenantTransaction } from "../src/database/postgres.mjs";
import { ManualEntryService, SALES_COLUMNS } from "../src/ingestion/manual-entry.mjs";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { ProductionWorker } from "../src/worker/production-worker.mjs";

const connectionString = process.env.TEST_DATABASE_URL;

class TestStorage {
  constructor() { this.objects = new Map(); this.fail = false; }
  async headObject({ key }) { return { exists: this.objects.has(key) }; }
  async putObject({ key, body }) {
    if (this.fail) throw new Error("Temporary storage failure");
    this.objects.set(key, { body: Buffer.from(body) });
  }
  async getObject({ key }) { return this.objects.get(key); }
}

test("PostgreSQL manual entry: runtime grants, durable ledger, worker, retries, isolation and overlap", { skip: !connectionString }, async (t) => {
  const admin = new pg.Pool({ connectionString });
  const runtime = new pg.Pool({ connectionString, options: "-c role=biznoryx_app" });
  const identity = new PostgresIdentityRepository(admin, { production: false });
  const repo = new PostgresManualEntryRepository(runtime);
  const storage = new TestStorage();
  const service = new ManualEntryService({ repository: repo, objectStorage: storage });
  const ingestion = new ProductionIngestionService({ repository: new PostgresDataIngestionRepository(runtime), objectStorage: storage });
  const metrics = new PostgresVerifiedMetricsRepository(runtime);

  async function tenant() {
    const nonce = randomUUID();
    const owner = await identity.createUser({ email: `manual-${nonce}@example.com`, displayName: "Manual Test Owner", password: "ManualTestStrongPassword2026!" });
    const organization = await identity.createOrganization({ actorUserId: owner.id, name: `Manual ${nonce}`, slug: `manual-${nonce}` });
    return { organizationId: organization.id, actorUserId: owner.id };
  }
  async function save(scope, extra = {}) {
    return (await service.saveDraft({ ...scope, dataSeries: "Sales", period: "2026-10", rows: [["2026-10-01", "A", "1", "0.10"]], ...extra })).draft;
  }
  async function validate(scope, draft) {
    const result = await service.validateDraft({ ...scope, draftId: draft.id, version: draft.version });
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    return { ...scope, draftId: draft.id, version: draft.version, validationId: result.validationId };
  }
  async function submit(scope, draft) { return service.submit(await validate(scope, draft)); }
  async function process(upload) {
    const jobs = new PostgresProcessingJobRepository(runtime);
    const workerId = `manual-test-${randomUUID()}`;
    // Lease only this test's job; never consume another suite's queue.
    jobs.leaseNext = async () => {
      const result = await admin.query(
        `update processing_jobs set status = 'leased', attempts = attempts + 1,
         leased_by = $2, leased_at = now(), lease_expires_at = now() + interval '60 seconds'
         where ingestion_run_id = $1 and status in ('queued','failed')
         returning id, organization_id, ingestion_run_id, job_type`,
        [upload.ingestionRun.id, workerId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, organizationId: row.organization_id, ingestionRunId: row.ingestion_run_id, jobType: row.job_type } : null;
    };
    const errors = [];
    const worker = new ProductionWorker({ repository: jobs, objectStorage: storage, metricsRepository: metrics,
      comparisonRepository: new PostgresMetricComparisonRepository(runtime),
      workerId, onError: (error) => errors.push(error) });
    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(errors, []);
    const result = await admin.query("select status from processing_jobs where ingestion_run_id = $1", [upload.ingestionRun.id]);
    assert.equal(result.rows[0].status, "succeeded");
  }
  async function revenue(scope) {
    const series = await metrics.listSeries(scope);
    const item = series.find((metric) => metric.sourceColumn === "revenue" && metric.aggregation === "sum");
    assert.ok(item);
    assert.equal(item.points.length, 1, "one aggregate per series/month");
    return item.points[0];
  }

  try {
    await t.test("fresh bootstrap grants a restricted runtime role", async () => {
      const role = await runtime.query("select current_user, rolbypassrls from pg_roles where rolname = current_user");
      assert.equal(role.rows[0].current_user, "biznoryx_app");
      assert.equal(role.rows[0].rolbypassrls, false);
      const privileges = await runtime.query(`select
        has_table_privilege(current_user, 'manual_entry_drafts', 'UPDATE') as drafts,
        has_table_privilege(current_user, 'manual_entry_submissions', 'INSERT') as submissions,
        has_table_privilege(current_user, 'manual_entry_submissions', 'UPDATE') as mutate,
        has_function_privilege(current_user, 'claim_ingestion_period_source(uuid,uuid,text,text)', 'EXECUTE') as claim`);
      assert.deepEqual(privileges.rows[0], { drafts: true, submissions: true, mutate: false, claim: true });
    });

    await t.test("drafts recover invalid cells; optimistic writes, canonical column order and validation version", async () => {
      const scope = await tenant();
      const columns = [SALES_COLUMNS[3], SALES_COLUMNS[0], SALES_COLUMNS[2], SALES_COLUMNS[1]];
      const first = await save(scope, { columns, rows: [["bad", "2026-10-01", "2", "A"], ["", "", "", ""]] });
      assert.deepEqual(first.rows[0], ["2026-10-01", "A", "2", "bad"]);
      const recovered = await new PostgresManualEntryRepository(runtime).load({ ...scope, draftId: first.id });
      assert.deepEqual(recovered.draft.rows, first.rows);
      const invalid = await service.validateDraft({ ...scope, draftId: first.id, version: 1 });
      assert.ok(invalid.issues.some((issue) => issue.row === 1 && issue.column === 4));
      await assert.rejects(service.submit({ ...scope, draftId: first.id, version: 1 }), { code: "DRAFT_NOT_VALIDATED" });
      const writes = await Promise.allSettled([1, 2].map(() => service.saveDraft({ ...scope, id: first.id, version: 1,
        dataSeries: "Sales", period: "2026-10", rows: [["2026-10-01", "A", "2", "0.20"], ["", "", "", ""]] })));
      assert.equal(writes.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(writes.find((item) => item.status === "rejected").reason.code, "DRAFT_VERSION_CONFLICT");
      const current = writes.find((item) => item.status === "fulfilled").value.draft;
      const verified = await validate(scope, current);
      const next = await save(scope, { id: current.id, version: current.version });
      await assert.rejects(service.submit(verified), { code: "DRAFT_VERSION_CONFLICT" });
      assert.equal(next.validatedVersion, null);
      const counts = await admin.query("select count(*)::int as count from ingestion_runs where organization_id = $1", [scope.organizationId]);
      assert.equal(counts.rows[0].count, 0);
    });

    await t.test("daily additions accumulate, identical rows count, corrections preserve originals, and workers select one monthly total", async () => {
      const scope = await tenant();
      const first = await submit(scope, await save(scope));
      assert.equal(first.submission.dataSeries, "Sales");
      assert.equal(first.submission.reportingPeriodId, first.upload.reportingPeriod.id);
      assert.equal(first.upload.ingestionRun.dataStatus, "partial");
      const secondDraft = await save(scope, { rows: [["2026-10-02", "A", "2", "0.20"], ["2026-10-02", "A", "2", "0.20"]] });
      const secondInput = await validate(scope, secondDraft);
      await assert.rejects(service.submit(secondInput), { code: "MANUAL_PROCESSING_PENDING" });
      await process(first.upload);
      assert.equal((await revenue(scope)).value, "0.1");
      const second = await service.submit(secondInput);
      assert.equal(second.submission.snapshotRowCount, 3);
      assert.equal(second.upload.reportingPeriod.id, first.upload.reportingPeriod.id);
      const stored = await storage.getObject({ key: second.upload.rawObject.storageKey });
      assert.equal(parse(stored.body.toString()).length, 4);
      await process(second.upload);
      assert.equal((await revenue(scope)).value, "0.5");
      const correctionDraft = await save(scope, { correctionOf: second.submission.id, rows: [["2026-10-02", "A", "2", "0.30"]] });
      const corrected = await submit(scope, correctionDraft);
      assert.equal(corrected.submission.revision, 2);
      assert.equal(corrected.submission.snapshotRowCount, 2);
      assert.equal(corrected.submission.batchId, second.submission.batchId);
      await process(corrected.upload);
      assert.equal((await revenue(scope)).value, "0.4");
      const detail = await service.load({ ...scope, submissionId: second.submission.id });
      assert.equal(detail.submission.rows.length, 2);
      assert.equal(detail.submissions.length, 2);
      assert.ok(detail.submissions.some((item) => item.id === corrected.submission.id));
      const stale = await save(scope, { rows: [["2026-10-04", "A", "1", "0.1"]] });
      await assert.rejects(save(scope, { correctionOf: second.submission.id }), { code: "CORRECTION_VERSION_CONFLICT" });
      assert.ok(stale.id);
      const noChange = await submit(scope, await save(scope, { correctionOf: corrected.submission.id, rows: corrected.submission.rows }));
      assert.equal(noChange.upload.rawObject.id, corrected.upload.rawObject.id, "no-op revision may share immutable source bytes");
      await process(noChange.upload);
      assert.equal((await revenue(scope)).value, "0.4");
      await assert.rejects(admin.query("update manual_entry_submissions set rows = '[]' where id = $1", [first.submission.id]), /immutable/);
      await assert.rejects(save(scope, { id: first.draft.id, version: 1 }), { code: "DRAFT_ALREADY_SUBMITTED" });
      const status = await admin.query("select data_status from reporting_periods where id = $1", [first.upload.reportingPeriod.id]);
      assert.equal(status.rows[0].data_status, "partial");
      assert.ok(!(await service.load(scope)).drafts.some((item) => item.id === first.draft.id), "delivered submissions do not remain editable drafts");
      const nextMonth = await submit(scope, await save(scope, { period: "2026-11", rows: [["2026-11-01", "A", "1", "1.00"]] }));
      await process(nextMonth.upload);
      const comparisons = await admin.query("select status, percent_change_numeric, evidence from verified_metric_comparisons where organization_id = $1 order by created_at desc", [scope.organizationId]);
      assert.ok(comparisons.rowCount > 0);
      assert.ok(comparisons.rows.every((item) => item.status === "not_ready" && item.percent_change_numeric === null));
      assert.ok(comparisons.rows.some((item) => /partial/.test(item.evidence.reason)));
    });

    await t.test("storage and database failures recover with durable identity; concurrent retries create one job", async () => {
      const scope = await tenant();
      const input = await validate(scope, await save(scope));
      storage.fail = true;
      await assert.rejects(service.submit(input), /Temporary storage failure/);
      storage.fail = false;
      const durable = await admin.query("select id from manual_entry_submissions where draft_id = $1", [input.draftId]);
      assert.equal(durable.rows.length, 1);
      const brokenPool = { async connect() { throw new Error("Temporary database failure"); } };
      const prepared = await repo.prepareSubmission(input);
      const recoveringService = new ManualEntryService({ repository: {
        prepareSubmission: () => repo.prepareSubmission(input),
        finalizeSubmission: (data) => new PostgresManualEntryRepository(brokenPool).finalizeSubmission(data),
      }, objectStorage: storage });
      await assert.rejects(recoveringService.submit(input), /Temporary database failure/);
      const renewed = new ManualEntryService({ repository: new PostgresManualEntryRepository(runtime), objectStorage: storage });
      const submitted = await Promise.all([renewed.submit(input), service.submit(input)]);
      assert.equal(submitted[0].submission.id, prepared.submission.id);
      assert.equal(submitted[0].upload.ingestionRun.id, submitted[1].upload.ingestionRun.id);
      const counts = await admin.query("select count(*)::int as count from processing_jobs where ingestion_run_id = $1", [submitted[0].upload.ingestionRun.id]);
      assert.equal(counts.rows[0].count, 1);
    });

    await t.test("existing schemas reuse optional decimal/text/boolean columns and require a daily entry date", async () => {
      const scope = await tenant();
      const existing = await ingestion.upload({ ...scope, fileName: "existing.csv", dataSeries: "Inventory", period: "2026-09",
        content: "product,active,quantity\nA,true,2\nB,false,\n" });
      const loaded = await service.load({ ...scope, dataSeries: "Inventory", period: "2026-10" });
      assert.equal(loaded.draft.dataStreamId, existing.dataStream.id);
      assert.deepEqual(loaded.draft.columns.map((column) => column.name), ["active", "product", "quantity"]);
      const current = await save(scope, { dataSeries: "Inventory", entryDate: "2026-10-03", rows: [["false", "C", ""]] });
      const submitted = await submit(scope, current);
      assert.equal(submitted.upload.dataStream.id, existing.dataStream.id);
      assert.equal(submitted.upload.schemaVersion.id, existing.schemaVersion.id);
      assert.ok((await storage.getObject({ key: submitted.upload.rawObject.storageKey })).body.toString().includes('"false","C",""'));
      const wrong = await save(scope, { dataSeries: "Inventory", rows: [["true", "D", "1"]] });
      assert.equal((await service.validateDraft({ ...scope, draftId: wrong.id, version: 1 })).valid, false);
      await assert.rejects(save(scope, { dataSeries: "Inventory", columns: SALES_COLUMNS }), { code: "MANUAL_SCHEMA_CONFLICT" });
    });

    await t.test("both overlap directions and simultaneous upload/manual submit are blocked under tenant locks", async () => {
      const manualScope = await tenant();
      await submit(manualScope, await save(manualScope));
      await assert.rejects(ingestion.upload({ ...manualScope, fileName: "full.csv", dataSeries: "Sales", period: "2026-10",
        content: "date,product,quantity,revenue\n2026-10-01,A,1,1\n" }), { code: "SOURCE_MODE_CONFLICT" });
      const uploadScope = await tenant();
      await ingestion.upload({ ...uploadScope, fileName: "full.csv", dataSeries: "Sales", period: "2026-10",
        content: "date,product,quantity,revenue\n2026-10-01,A,1,1\n" });
      await assert.rejects(submit(uploadScope, await save(uploadScope)), { code: "SOURCE_MODE_CONFLICT" });
      const raceScope = await tenant();
      const input = await validate(raceScope, await save(raceScope));
      const results = await Promise.allSettled([
        service.submit(input), ingestion.upload({ ...raceScope, fileName: "race.csv", dataSeries: "Sales", period: "2026-10",
          content: "date,product,quantity,revenue\n2026-10-02,B,2,2\n" }),
      ]);
      assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(results.find((item) => item.status === "rejected").reason.code, "SOURCE_MODE_CONFLICT");
      const modes = await admin.query("select input_mode from manual_entry_period_sources where organization_id = $1", [raceScope.organizationId]);
      assert.equal(modes.rows.length, 1);
    });

    await t.test("tenant ownership, RLS, viewers and disabled actors are enforced on the server", async () => {
      const scope = await tenant();
      const other = await tenant();
      const current = await save(scope);
      const submission = await submit(scope, current);
      await assert.rejects(service.load({ ...other, draftId: current.id }), { code: "MANUAL_NOT_FOUND" });
      await assert.rejects(service.load({ ...other, submissionId: submission.submission.id }), { code: "MANUAL_NOT_FOUND" });
      await assert.rejects(service.load({ ...scope, actorUserId: other.actorUserId }), { code: "ORG_ACCESS_DENIED" });
      await assert.rejects(save(other, { correctionOf: submission.submission.id }), { code: "MANUAL_NOT_FOUND" });
      await save(scope);
      const rows = await withTenantTransaction(runtime, other, (client) => client.query("select id from manual_entry_submissions where id = $1", [submission.submission.id]));
      assert.equal(rows.rowCount, 0);
      await assert.rejects(withTenantTransaction(runtime, other, (client) => client.query(
        "insert into manual_entry_period_sources(organization_id,data_stream_id,period,input_mode) values($1,$2,'2026-11','manual_entry')",
        [scope.organizationId, current.dataStreamId],
      )), /row-level security/);
      await admin.query("update organization_memberships set role = 'viewer' where organization_id = $1 and user_id = $2", [scope.organizationId, scope.actorUserId]);
      assert.ok((await service.load(scope)).drafts.length);
      await assert.rejects(save(scope), { code: "CAPABILITY_DENIED" });
      await assert.rejects(service.validateDraft({ ...scope, draftId: current.id, version: 1 }), { code: "CAPABILITY_DENIED" });
      await assert.rejects(service.submit({ ...scope, draftId: current.id, version: 1 }), { code: "CAPABILITY_DENIED" });
      await admin.query("update organizations set disabled_at = now() where id = $1", [other.organizationId]);
      await assert.rejects(save(other), { code: "ORG_ACCESS_DENIED" });
    });
  } finally {
    await runtime.end();
    await admin.end();
  }
});
