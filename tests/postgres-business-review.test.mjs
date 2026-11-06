import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { zipSync } from "fflate";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { PostgresImportManifestRepository } from "../src/database/import-manifest-repository.mjs";
import { PostgresMoneyTrailRepository } from "../src/database/money-trail-repository.mjs";
import { PostgresMonthlyCloseRepository } from "../src/database/monthly-close-repository.mjs";
import { PostgresEvidenceReportRepository } from "../src/database/evidence-report-repository.mjs";
import { PostgresVerifiedMetricsRepository } from "../src/database/verified-metrics-repository.mjs";
import { PostgresBusinessOnboardingRepository } from "../src/database/business-onboarding-repository.mjs";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { financialSourcePreview } from "../src/ingestion/money-trail-source.mjs";
import { deriveCsvMetrics } from "../src/worker/production-worker.mjs";
import { withTenantTransaction } from "../src/database/postgres.mjs";
import { PostgresUpdatesRepository } from "../src/database/updates-repository.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";
import { PostgresBusinessReviewRelease } from "../src/database/business-review-release.mjs";
import { AuthError } from "../src/auth/core.mjs";

const skip = !process.env.TEST_DATABASE_URL;
const sheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function workbook() {
  const rows = [
    ["date", "amount", "reference", "description"],
    ["2026-01-01", "50000", "INV-1", "First sale"],
    ["2026-01-31", "50000", "INV-2", "Second sale"],
  ];
  const cells = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`,
    )
    .join("");
  const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const doc =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries({
          "[Content_Types].xml":
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
          "_rels/.rels": `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${doc}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
          "xl/workbook.xml": `<workbook xmlns="${sheetNS}" xmlns:r="${doc}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
          "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${doc}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
          "xl/worksheets/sheet1.xml": `<worksheet xmlns="${sheetNS}"><sheetData>${cells}</sheetData></worksheet>`,
        }).map(([name, text]) => [name, Buffer.from(text)]),
      ),
    ),
  );
}

test(
  "reviewed imports, exact allocations, immutable close and tenant boundaries use real PostgreSQL",
  { skip },
  async () => {
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const identity = new PostgresIdentityRepository(pool, {
      production: false,
    });
    const ingestion = new PostgresDataIngestionRepository(pool),
      profiles = new PostgresImportManifestRepository(pool);
    const money = new PostgresMoneyTrailRepository(pool),
      monthly = new PostgresMonthlyCloseRepository(pool);
    const metrics = new PostgresVerifiedMetricsRepository(pool),
      policies = new PostgresEvidenceReportRepository(pool);
    const objects = new Map();
    const storage = {
      async headObject({ key }) {
        const object = objects.get(key);
        return {
          exists: Boolean(object),
          byteSize: object?.body.length,
          metadata: object?.metadata,
        };
      },
      async putObject({ key, body, ...metadata }) {
        objects.set(key, { body: Buffer.from(body), ...metadata });
      },
      async getObject({ key }) {
        if (!objects.has(key)) throw Error("Missing source");
        return objects.get(key);
      },
    };
    const service = new ProductionIngestionService({
      repository: ingestion,
      objectStorage: storage,
      profileRepository: profiles,
    });
    try {
      const nonce = randomUUID();
      const create = async (label) => {
        const actor = await identity.createUser({
          email: `${label}-${nonce}@example.com`,
          displayName: label,
          password: "SyntheticFeatureTest2026!",
        });
        const org = await identity.createOrganization({
          actorUserId: actor.id,
          name: label,
          slug: `${label.toLowerCase()}-${nonce}`,
        });
        return { organizationId: org.id, actorUserId: actor.id };
      };
      const tenant = await create("Owner"),
        other = await create("Outsider"),
        viewer = await create("Viewer");
      await withTenantTransaction(pool, tenant, (c) =>
        c.query(
          "insert into organization_memberships(organization_id,user_id,role,status) values($1,$2,'viewer','active')",
          [tenant.organizationId, viewer.actorUserId],
        ),
      );
      assert.equal(
        await new PostgresBusinessReviewRelease(pool).allowed(tenant),
        false,
      );
      await assert.rejects(
        pool.query(
          "update business_review_release set enabled=true where singleton",
        ),
        /permission denied/i,
      );
      const readOnly = { ...tenant, actorUserId: viewer.actorUserId };
      await new PostgresBusinessOnboardingRepository(pool).upsertProfile({
        ...tenant,
        profile: {
          legalName: "Synthetic only",
          industry: "Retail",
          businessModel: "Sales",
          primaryCurrency: "NGN",
          fiscalYearStartMonth: 1,
          timezone: "Africa/Lagos",
        },
      });
      const bytes = workbook(),
        payload = {
          ...tenant,
          fileName: "synthetic-sales.xlsx",
          contentBase64: bytes.toString("base64"),
          dataSeries: "Synthetic sales",
          period: "2026-01",
        };
      const preview = await service.preview(payload);
      assert.equal(preview.rowCount, 2);
      const profile = await profiles.approve({
        ...tenant,
        dataStreamId: preview.dataStream.id,
        expectedVersion: 0,
        definition: {
          sourceRole: "sales",
          currency: "NGN",
          dateConvention: "ISO",
          columns: preview.columns.map((c) => c.name),
          mapping: {
            date: "date",
            amount: "amount",
            reference: "reference",
            description: "description",
          },
        },
      });
      await assert.rejects(
        profiles.approve({
          ...readOnly,
          dataStreamId: preview.dataStream.id,
          definition: profile.definition,
        }),
        /denied/i,
      );
      await assert.rejects(
        profiles.approve({
          ...tenant,
          dataStreamId: preview.dataStream.id,
          expectedVersion: 0,
          definition: profile.definition,
        }),
        /changed/,
      );
      const beforeDenied = objects.size;
      await assert.rejects(
        service.uploadReviewed({
          ...payload,
          actorUserId: readOnly.actorUserId,
          profileId: profile.id,
          reviewedChecksum: preview.checksumSha256,
        }),
        /denied/i,
      );
      assert.equal(
        objects.size,
        beforeDenied,
        "Read-only users cannot write even an orphan source artifact",
      );
      const committed = await service.uploadReviewed({
        ...payload,
        profileId: profile.id,
        reviewedChecksum: preview.checksumSha256,
      });
      assert.equal(committed.ingestionRun.status, "validated");
      const retry = await service.uploadReviewed({
        ...payload,
        profileId: profile.id,
        reviewedChecksum: preview.checksumSha256,
      });
      assert.equal(retry.ingestionRun.id, committed.ingestionRun.id);
      assert.equal(retry.idempotent, true);
      const downloaded = await service.download({
        ...tenant,
        uploadId: committed.ingestionRun.id,
      });
      assert.deepEqual(downloaded.body, bytes);
      assert.equal(downloaded.fileName, payload.fileName);
      assert.equal(
        (await ingestion.listUploads(tenant))[0].rawObject.originalFilename,
        payload.fileName,
      );
      await assert.rejects(
        service.download({ ...other, uploadId: committed.ingestionRun.id }),
        /not found/i,
      );
      const derivative = await ingestion.getNormalizedFile({
        ...tenant,
        uploadId: committed.ingestionRun.id,
      });
      const normalized = objects.get(derivative.storageKey).body;
      assert.match(normalized.toString(), /2026-01-01,50000/);
      await metrics.replaceIngestionMetrics({
        organizationId: tenant.organizationId,
        ingestionRunId: committed.ingestionRun.id,
        metrics: deriveCsvMetrics({
          body: normalized,
          originalFilename: derivative.originalFilename,
        }),
      });
      // This fixture derives real metrics directly; existing durable-worker tests
      // cover leasing. Mark only this synthetic run complete for the close checklist.
      await withTenantTransaction(pool, tenant, (c) =>
        c.query(
          "update processing_jobs set status='succeeded',completed_at=now() where organization_id=$1 and ingestion_run_id=$2",
          [tenant.organizationId, committed.ingestionRun.id],
        ),
      );
      await policies.approvePolicy({
        ...tenant,
        seriesKey: preview.dataStream.id,
        column: "amount",
        expectedVersion: 0,
        definition: {
          label: "Recorded sales",
          unit: "currency",
          polarity: "higher",
          materialityPercent: 5,
        },
      });

      const financial = financialSourcePreview({
        body: normalized,
        profile: profile.definition,
        sourceChecksum: derivative.checksumSha256,
        profileId: profile.id,
      });
      assert.equal(financial.issues.length, 0);
      assert.equal(financial.records[0].paymentStatus, "unknown");
      const imported = await money.importRecords({
        ...tenant,
        ingestionRunId: committed.ingestionRun.id,
        records: financial.records,
        idempotencyKey: financial.checksum,
      });
      assert.equal(imported.importedCount, 2);
      assert.equal(
        (
          await money.importRecords({
            ...tenant,
            ingestionRunId: committed.ingestionRun.id,
            records: financial.records,
            idempotencyKey: financial.checksum,
          })
        ).idempotent,
        true,
      );
      const receipt = await service.upload({
        ...tenant,
        fileName: "receipts.csv",
        content: "date,amount,reference\n2026-02-01,60000,INV-1\n",
        period: "2026-02",
        dataSeries: "Synthetic receipts",
      });
      await money.importRecords({
        ...tenant,
        ingestionRunId: receipt.ingestionRun.id,
        idempotencyKey: "receipt-1",
        records: [
          {
            sourceRowLocator: "record:2",
            date: "2026-02-01",
            amount: "60000",
            kind: "receipt",
            reference: "INV-1",
            referenceConfirmed: true,
          },
        ],
      });
      let report = await money.list(tenant),
        sale = report.records.find((r) => r.kind === "sale"),
        payment = report.records.find((r) => r.kind === "receipt");
      await money.classify({
        ...tenant,
        id: sale.id,
        expectedVersion: sale.version,
        classification: {
          kind: "sale",
          paymentStatus: "confirmed_receivable",
          referenceConfirmed: true,
          reason: "Synthetic invoice confirmed",
        },
      });
      report = await money.list(tenant);
      sale = report.records.find((r) => r.id === sale.id);
      payment = report.records.find((r) => r.id === payment.id);
      const allocationRequest = {
        ...tenant,
        saleId: sale.id,
        receiptId: payment.id,
        amount: "40000.00",
        expectedSaleVersion: sale.version,
        expectedReceiptVersion: payment.version,
      };
      const concurrent = await Promise.allSettled([
        money.allocate(allocationRequest),
        money.allocate(allocationRequest),
      ]);
      assert.equal(
        concurrent.filter((r) => r.status === "fulfilled").length,
        1,
      );
      report = await money.list(tenant);
      assert.equal(report.totals.allocatedReceipts, "40000.00");
      assert.equal(report.totals.recordedSales, "100000.00");
      assert.equal(report.totals.confirmedBalance, "10000.00");
      assert.equal(report.totals.unallocatedReceipts, "20000.00");
      sale = report.records.find((r) => r.id === sale.id);
      payment = report.records.find((r) => r.id === payment.id);
      await assert.rejects(
        money.allocate({
          ...allocationRequest,
          amount: "20000",
          expectedSaleVersion: sale.version,
          expectedReceiptVersion: payment.version,
        }),
        /exceed/i,
      );
      await assert.rejects(
        money.allocate({ ...allocationRequest, ...other }),
        /not found/i,
      );
      await assert.rejects(
        money.allocate({ ...allocationRequest, ...readOnly }),
        /capability/i,
      );
      const allocation = report.allocations[0];
      await money.reverseAllocation({
        ...tenant,
        allocationId: allocation.id,
        reason: "Synthetic reversal test",
      });
      report = await money.list(tenant);
      assert.equal(report.totals.allocatedReceipts, "0");
      assert.equal(report.totals.unallocatedReceipts, "60000.00");
      const isolated = await withTenantTransaction(pool, other, (c) =>
        c.query("select id from money_trail_records where organization_id=$1", [
          tenant.organizationId,
        ]),
      );
      assert.equal(isolated.rowCount, 0);

      const draftInput = {
        ...tenant,
        period: "2026-01",
        idempotencyKey: "monthly-test-1",
        report: {
          sourceId: committed.ingestionRun.id,
          metric: { column: "amount" },
          evidence: { dateColumn: "date" },
          previous: { period: "none" },
        },
      };
      await monthly.setRequiredSources({
        ...tenant,
        period: "2026-01",
        expectedVersion: 0,
        dataStreamIds: [preview.dataStream.id],
      });
      const draft = await monthly.createDraft(draftInput);
      assert.equal(draft.evidenceManifest.importProfiles[0].version, 1);
      assert.equal(
        draft.evidenceManifest.sources[0].originalArtifact.checksum,
        preview.checksumSha256,
      );
      assert.equal(draft.report.current.value, "100000");
      assert.equal(draft.status, "draft");
      assert.equal((await monthly.createDraft(draftInput)).id, draft.id);
      assert.deepEqual(draft.approvalBlockers, []);
      await assert.rejects(
        monthly.approve({ ...readOnly, id: draft.id, expectedVersion: 1 }),
        /denied/i,
      );
      const approved = await monthly.approve({
        ...tenant,
        id: draft.id,
        expectedVersion: 1,
      });
      assert.equal(approved.status, "approved");
      const second = await monthly.createDraft({
        ...draftInput,
        idempotencyKey: "monthly-test-2",
        supersedesId: approved.id,
      });
      await monthly.approve({
        ...tenant,
        id: second.id,
        expectedVersion: second.version,
      });
      const archived = await monthly.get({ ...tenant, id: approved.id });
      assert.equal(archived.status, "superseded");
      assert.equal(archived.report.current.value, "100000");
      assert.equal(archived.contentHash, approved.contentHash);
      await assert.rejects(
        monthly.get({ ...other, id: approved.id }),
        /not found/i,
      );
      await assert.rejects(
        withTenantTransaction(pool, tenant, (c) =>
          c.query(
            "update monthly_close_versions set report='{}'::jsonb where id=$1",
            [approved.id],
          ),
        ),
        /permission|immutable/i,
      );
      await withTenantTransaction(pool, tenant, (c) =>
        c.query("select deliver_source_updates(100)"),
      );
      const updates = await new PostgresUpdatesRepository(pool).list({
        ...tenant,
        limit: 50,
      });
      assert.ok(updates.items.some((i) => i.kind === "monthly_review"));
      assert.ok(updates.items.some((i) => i.kind === "money_review"));
      assert.ok(
        updates.items
          .filter((i) => i.kind === "monthly_review")
          .every((i) => i.href === "#/monthly-review"),
      );

      // Exercise real production routes with isolated repository/storage data.
      // The identity adapter isolates authentication transport; installed-device
      // login and third-party billing are not claimed by this test.
      let active = tenant,
        paid = true,
        releaseEnabled = true;
      const app = createProductionApp({
        pool,
        production: false,
        objectStorage: storage,
        // Scoped rollout adapter; the real default-off metadata/grants are checked above.
        reviewReleaseRepository: {
          async allowed() {
            return releaseEnabled;
          },
        },
        emailVerificationRepository: {},
        identityRepository: {
          async authenticate({ requireCsrf, csrfToken }) {
            if (requireCsrf && csrfToken !== "csrf-test")
              throw new AuthError("Invalid CSRF token.", "CSRF_INVALID");
            return {
              user: { id: active.actorUserId },
              session: { activeOrganizationId: active.organizationId },
            };
          },
        },
        billingRepository: {
          async ensureSubscription() {
            return {
              status: paid ? "active" : "past_due",
              currentPeriodEnd: new Date(Date.now() + 86400000),
            };
          },
        },
      });
      await new Promise((resolve) =>
        app.server.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${app.server.address().port}/api/`;
      const request = (path, body, csrf = true) =>
        fetch(base + path, {
          method: body ? "POST" : "GET",
          headers: {
            cookie: "bnx_session=synthetic",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(csrf ? { "x-csrf-token": "csrf-test" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      try {
        releaseEnabled = false;
        const gated = await (await request("business-review")).json();
        assert.equal(gated.reviewedImports, false);
        assert.equal(gated.moneyTrail, false);
        assert.equal(gated.monthlyClose, false);
        assert.deepEqual(gated.formats, ["csv"]);
        assert.equal(
          (
            await request("ingestion/preview", {
              fileName: "test.csv",
              content: "a,b\n1,2",
              period: "2026-03",
            })
          ).status,
          503,
        );
        assert.equal((await request("money-trail")).status, 503);
        assert.equal(
          (
            await request(
              "ingestion/uploads/" + committed.ingestionRun.id + "/download",
            )
          ).status,
          200,
        );
        releaseEnabled = true;
        assert.equal(
          (await (await request("business-review")).json()).reviewedImports,
          true,
        );
        assert.equal(
          (
            await request(
              "ingestion/preview",
              { fileName: "test.csv", content: "a,b\n1,2", period: "2026-03" },
              false,
            )
          ).status,
          403,
        );
        const response = await request("ingestion/preview", {
          fileName: "http.csv",
          content: "date,amount\n2026-03-01,10\n",
          period: "2026-03",
          dataSeries: "HTTP isolated",
          organizationId: other.organizationId,
        });
        assert.equal(response.status, 200, await response.clone().text());
        const preview = (await response.json()).preview;
        assert.equal(preview.dataStream.organizationId, tenant.organizationId);
        assert.equal((await request("money-trail")).status, 200);
        const packet = await request("monthly-close?id=" + second.id);
        assert.equal(packet.status, 200, await packet.clone().text());
        assert.equal((await packet.json()).item.evidenceStatus, "available");
        const original = await ingestion.getSourceFile({
          ...tenant,
          uploadId: committed.ingestionRun.id,
        });
        await withTenantTransaction(pool, tenant, (c) =>
          c.query(
            "update raw_data_objects set status='quarantined' where organization_id=$1 and id=$2",
            [tenant.organizationId, original.id],
          ),
        );
        assert.equal(
          (await monthly.get({ ...tenant, id: second.id })).evidenceStatus,
          "unavailable",
        );
        await assert.rejects(
          service.download({ ...tenant, uploadId: committed.ingestionRun.id }),
          /not found/i,
        );
        await withTenantTransaction(pool, tenant, (c) =>
          c.query(
            "update raw_data_objects set status='accepted' where organization_id=$1 and id=$2",
            [tenant.organizationId, original.id],
          ),
        );
        active = readOnly;
        assert.equal(
          (
            await request("monthly-close/sources", {
              period: "2026-01",
              expectedVersion: 1,
              dataStreamIds: [preview.dataStream.id],
            })
          ).status,
          404,
        );
        active = other;
        assert.equal(
          (await request("monthly-close?id=" + second.id)).status,
          404,
        );
        assert.equal(
          (
            await request("ingestion/preview", {
              uploadId: committed.ingestionRun.id,
            })
          ).status,
          404,
        );
        active = tenant;
        paid = false;
        assert.equal((await request("money-trail")).status, 402);
      } finally {
        await new Promise((resolve) => app.server.close(resolve));
      }

      const existing = await service.preview({
        ...tenant,
        uploadId: receipt.ingestionRun.id,
      });
      const receiptProfile = await profiles.approve({
        ...tenant,
        dataStreamId: existing.dataStream.id,
        expectedVersion: 0,
        definition: {
          sourceRole: "receipts",
          currency: "NGN",
          dateConvention: "ISO",
          columns: existing.columns.map((c) => c.name),
          mapping: { date: "date", amount: "amount", reference: "reference" },
        },
      });
      await profiles.attachExisting({
        ...tenant,
        uploadId: receipt.ingestionRun.id,
        profileId: receiptProfile.id,
        reviewedChecksum: existing.checksumSha256,
        columns: existing.columns.map((c) => c.name),
        parserVersion: existing.parserVersion,
      });
      assert.equal(
        (
          await profiles.source({
            ...tenant,
            uploadId: receipt.ingestionRun.id,
          })
        ).profile_id,
        receiptProfile.id,
      );
      const correctionPayload = {
        ...tenant,
        fileName: "synthetic-correction.csv",
        content:
          "date,amount,reference,description\n2026-01-01,45000,INV-1,Corrected first sale\n2026-01-31,65000,INV-2,Corrected second sale\n",
        period: "2026-01",
        dataSeries: payload.dataSeries,
      };
      const correctedPreview = await service.preview(correctionPayload);
      await assert.rejects(
        service.uploadReviewed({
          ...correctionPayload,
          profileId: profile.id,
          reviewedChecksum: correctedPreview.checksumSha256,
        }),
        /corrected version/i,
      );
      const corrected = await service.uploadReviewed({
        ...correctionPayload,
        profileId: profile.id,
        reviewedChecksum: correctedPreview.checksumSha256,
        supersedesRunId: committed.ingestionRun.id,
      });
      const correctedFile = await ingestion.getNormalizedFile({
        ...tenant,
        uploadId: corrected.ingestionRun.id,
      });
      const newRecords = financialSourcePreview({
        body: objects.get(correctedFile.storageKey).body,
        profile: profile.definition,
        sourceChecksum: correctedFile.checksumSha256,
        profileId: profile.id,
      });
      await assert.rejects(
        money.importRecords({
          ...tenant,
          ingestionRunId: corrected.ingestionRun.id,
          records: newRecords.records,
          idempotencyKey: newRecords.checksum,
        }),
        /explicitly name/i,
      );
      await money.importRecords({
        ...tenant,
        ingestionRunId: corrected.ingestionRun.id,
        records: newRecords.records,
        idempotencyKey: newRecords.checksum,
        supersedesRunId: committed.ingestionRun.id,
        correctionReason: "Synthetic source correction reviewed",
      });
      const afterCorrection = await money.list(tenant);
      assert.equal(afterCorrection.totals.recordedSales, "110000.00");
      assert.equal(afterCorrection.sourceCorrections.length, 1);
      await assert.rejects(
        money.allocate({
          ...allocationRequest,
          expectedSaleVersion: 4,
          expectedReceiptVersion: 3,
        }),
        /superseded/i,
      );
      assert.equal(
        (await monthly.get({ ...tenant, id: approved.id })).report.current
          .value,
        "100000",
      );
    } finally {
      await pool.end();
    }
  },
);
