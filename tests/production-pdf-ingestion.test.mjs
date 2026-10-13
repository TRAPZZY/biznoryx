import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { createRawObjectIdentity } from "../src/ingestion/raw-object-identity.mjs";
import { tablePdf } from "./helpers/pdf-fixtures.mjs";

function runtime() {
  const objects = new Map();
  const registrations = [];
  const checksums = new Set();
  let writes = 0;
  const service = new ProductionIngestionService({
    objectStorage: {
      async headObject({ key }) { return { exists: objects.has(key) }; },
      async putObject(input) { writes++; objects.set(input.key, input); },
    },
    repository: {
      async ensureManualUploadSource() { return { id: "source" }; },
      async ensureStream() { return { id: "stream" }; },
      async registerRawUpload(input) {
        const identity = createRawObjectIdentity({ organizationId: input.organizationId, originalFilename: input.upload.originalFilename, content: input.upload.content });
        const key = input.organizationId + identity.checksumSha256;
        if (checksums.has(key)) throw new Error("This file has already been uploaded.");
        checksums.add(key);
        registrations.push(input);
        return { rawObject: { ...identity, status: "accepted" } };
      },
    },
  });
  return { service, objects, registrations, get writes() { return writes; } };
}

test("production PDF upload retains original bytes, media type, schema and tenant checksum", async () => {
  const body = await tablePdf();
  const state = runtime();
  const result = await state.service.upload({ organizationId: "org-a", actorUserId: "owner", fileName: "report.pdf", contentBase64: body.toString("base64"), period: "2026-10" });
  assert.equal(result.rawObject.checksumSha256, createHash("sha256").update(body).digest("hex"));
  assert.match(result.rawObject.storageKey, /^organizations\/org-a\/uploads\//);
  assert.deepEqual(state.objects.get(result.rawObject.storageKey).body, body);
  assert.equal(state.objects.get(result.rawObject.storageKey).contentType, "application/pdf");
  assert.equal(state.registrations[0].upload.rowCount, 2);
  assert.deepEqual(state.registrations[0].upload.columns.map(column => column.name), ["date", "product", "revenue"]);
  assert.deepEqual(state.registrations[0].upload.content, body);
});

test("PDF batch uploads forward binary payloads, preserve CSV and isolate identical bytes by tenant", async () => {
  const body = await tablePdf();
  const state = runtime();
  const pdf = { fileName: "report.pdf", contentBase64: body.toString("base64") };
  await state.service.uploadBatch({ organizationId: "org-a", actorUserId: "owner", files: [pdf, { fileName: "report.csv", content: "date,revenue\n2026-10-01,100" }], period: "2026-10" });
  await assert.rejects(state.service.upload({ organizationId: "org-a", actorUserId: "owner", ...pdf, period: "2026-10" }), /already been uploaded/);
  await state.service.upload({ organizationId: "org-b", actorUserId: "owner-b", ...pdf, period: "2026-10" });
  assert.equal(state.objects.size, 3);
  assert.equal(state.writes, 3);
});

test("unsafe PDF payloads fail before storage or registration", async () => {
  const state = runtime();
  const malformed = Buffer.from("%PDF-1.7\nnot a document\n%%EOF");
  for (const contentBase64 of ["bad!", "YWJj", malformed.toString("base64"), Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")]) {
    await assert.rejects(state.service.upload({ organizationId: "org-a", actorUserId: "owner", fileName: "report.pdf", contentBase64, period: "2026-10" }), error => error.code === "VALIDATION_FAILED");
  }
  assert.equal(state.objects.size, 0);
  assert.equal(state.registrations.length, 0);
});
