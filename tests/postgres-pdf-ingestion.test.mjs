import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { ProductionIngestionService } from "../src/ingestion/production-ingestion-service.mjs";
import { tablePdf } from "./helpers/pdf-fixtures.mjs";

test("PostgreSQL PDF ingestion persists original evidence, detects duplicates and refuses foreign actors", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const identity = new PostgresIdentityRepository(pool, { production: false });
  const repository = new PostgresDataIngestionRepository(pool);
  const objects = new Map();
  const service = new ProductionIngestionService({ repository, objectStorage: {
    async headObject({ key }) { return { exists: objects.has(key) }; },
    async putObject(input) { objects.set(input.key, input); },
  } });
  try {
    const suffix = Date.now() + "-" + Math.random().toString(36).slice(2);
    const a = await identity.createUser({ email: `pdf-a-${suffix}@example.com`, displayName: "PDF Owner A", password: "StrongPassword2026!" });
    const b = await identity.createUser({ email: `pdf-b-${suffix}@example.com`, displayName: "PDF Owner B", password: "StrongPassword2026!" });
    const orgA = await identity.createOrganization({ actorUserId: a.id, name: `PDF A ${suffix}`, slug: `pdf-a-${suffix}` });
    const orgB = await identity.createOrganization({ actorUserId: b.id, name: `PDF B ${suffix}`, slug: `pdf-b-${suffix}` });
    const original = await tablePdf();
    const input = { fileName: "report.pdf", contentBase64: original.toString("base64"), period: "2026-10", dataSeries: "PDF Sales" };
    const resultA = await service.upload({ ...input, organizationId: orgA.id, actorUserId: a.id });
    assert.equal(resultA.rawObject.status, "accepted");
    assert.equal(resultA.rawObject.contentType, "application/pdf");
    assert.equal(resultA.ingestionRun.rowCount, 2);
    assert.deepEqual(objects.get(resultA.rawObject.storageKey).body, original);
    await assert.rejects(service.upload({ ...input, organizationId: orgA.id, actorUserId: a.id }), /already been uploaded/);
    await assert.rejects(service.upload({ ...input, organizationId: orgA.id, actorUserId: b.id }), error => ["ORG_ACCESS_DENIED", "AUTHORIZATION_FAILED"].includes(error.code));
    const resultB = await service.upload({ ...input, organizationId: orgB.id, actorUserId: b.id });
    assert.equal(resultA.rawObject.checksumSha256, resultB.rawObject.checksumSha256);
    assert.notEqual(resultA.rawObject.storageKey, resultB.rawObject.storageKey);
    assert.equal(objects.size, 2);
    assert.ok(resultA.validationResults.every(item => item.severity !== "error"));
  } finally { await pool.end(); }
});
