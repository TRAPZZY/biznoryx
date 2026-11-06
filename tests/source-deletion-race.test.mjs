import assert from "node:assert/strict";
import test from "node:test";

import {
  createRawObjectIdentity,
  createUniqueRawObjectIdentity,
  isUniqueRawObjectStorageKey,
} from "../src/ingestion/raw-object-identity.mjs";

import {
  ProductionIngestionService,
} from "../src/ingestion/production-ingestion-service.mjs";

test("new R2 uploads cannot reuse an old source key", () => {
  const input = {
    organizationId: "org-a",
    originalFilename: "sales.csv",
    content: "product,revenue\nA,100\n",
  };

  const old = createRawObjectIdentity(input);
  const first = createUniqueRawObjectIdentity(input);
  const second = createUniqueRawObjectIdentity(input);

  assert.equal(first.checksumSha256, old.checksumSha256);
  assert.notEqual(first.storageKey, old.storageKey);
  assert.notEqual(first.storageKey, second.storageKey);

  assert.ok(isUniqueRawObjectStorageKey(old, first.storageKey));
});

test("deleting an old object does not delete a new upload", async () => {
  const content = "product,revenue\nA,100\n";

  const old = createRawObjectIdentity({
    organizationId: "org-a",
    originalFilename: "sales.csv",
    content,
  });

  const objects = new Map([[old.storageKey, Buffer.from(content)]]);

  const storage = {
    async headObject({ key }) {
      return { exists: objects.has(key) };
    },

    async putObject({ key, body }) {
      objects.set(key, Buffer.from(body));
    },

    async deleteObject({ key }) {
      objects.delete(key);
    },
  };

  const repository = {
    async ensureManualUploadSource() {
      return { id: "source-a" };
    },

    async ensureStream() {
      return { id: "stream-a" };
    },

    async registerRawUpload(input) {
      await storage.deleteObject({ key: old.storageKey });

      return {
        rawObject: {
          storageKey: input.upload.storageKey,
          checksumSha256: old.checksumSha256,
        },
        ingestionRun: { status: "validated" },
      };
    },
  };

  const uploader = new ProductionIngestionService({
    repository,
    objectStorage: storage,
  });

  const result = await uploader.upload({
    organizationId: "org-a",
    actorUserId: "user-a",
    fileName: "sales.csv",
    period: "2026-05",
    dataSeries: "Race Test",
    content,
  });

  assert.notEqual(result.rawObject.storageKey, old.storageKey);
  assert.equal(objects.has(old.storageKey), false);
  assert.equal(
    objects.get(result.rawObject.storageKey)?.toString("utf8"),
    content,
  );
});