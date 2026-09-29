import assert from "node:assert/strict";
import test from "node:test";

import {
  ProductionIngestionService,
} from "../src/ingestion/production-ingestion-service.mjs";

class FakeObjectStorage {
  constructor() {
    this.objects =
      new Map();

    this.putCalls = [];
    this.deleteCalls = [];
  }

  async headObject({
    key,
  }) {
    const object =
      this.objects.get(
        key,
      );

    if (!object) {
      return {
        exists: false,
        key,
      };
    }

    return {
      exists: true,
      key,

      byteSize:
        object.body
          .byteLength,

      contentType:
        object.contentType,
    };
  }

  async putObject({
    key,
    body,
    contentType,
    metadata,
  }) {
    const stored = {
      body:
        Buffer.from(
          body,
        ),

      contentType,

      metadata,
    };

    this.objects.set(
      key,
      stored,
    );

    this.putCalls.push({
      key,
      ...stored,
    });

    return {
      key,

      byteSize:
        stored.body
          .byteLength,

      contentType,
    };
  }

  async deleteObject({
    key,
  }) {
    this.objects.delete(
      key,
    );

    this.deleteCalls.push(
      key,
    );

    return {
      deleted: true,
      key,
    };
  }
}

function createRepository({
  rejected = false,
  failRegistration =
    false,
} = {}) {
  const calls = {
    source: [],
    stream: [],
    registration: [],
  };

  return {
    calls,

    repository: {
      async ensureManualUploadSource(
        input,
      ) {
        calls.source.push(
          input,
        );

        return {
          id:
            "source-1",
        };
      },

      async ensureStream(
        input,
      ) {
        calls.stream.push(
          input,
        );

        return {
          id:
            "stream-1",
        };
      },

      async registerRawUpload(
        input,
      ) {
        calls.registration.push(
          input,
        );

        if (
          failRegistration
        ) {
          throw new Error(
            "Database failed",
          );
        }

        const {
          createRawObjectIdentity,
        } =
          await import(
            "../src/ingestion/raw-object-identity.mjs"
          );

        const identity =
          createRawObjectIdentity({
            organizationId:
              input.organizationId,

            originalFilename:
              input.upload
                .originalFilename,

            content:
              input.upload
                .content,
          });

        return {
          rawObject: {
            id:
              "raw-1",

            storageKey:
              identity
                .storageKey,

            checksumSha256:
              identity
                .checksumSha256,

            status:
              rejected
                ? "rejected"
                : "accepted",
          },

          ingestionRun: {
            id:
              "run-1",

            status:
              rejected
                ? "rejected"
                : "validated",

            schemaDrift:
              rejected
                ? "breaking"
                : "none",
          },

          reportingPeriod:
            input
              .reportingPeriod,

          validationResults:
            rejected
              ? [
                  {
                    severity:
                      "error",

                    code:
                      "BREAKING_SCHEMA_DRIFT",
                  },
                ]
              : [],
        };
      },
    },
  };
}

test(
  "production ingestion parses CSV, stores immutable raw bytes and persists metadata",
  async () => {
    const {
      repository,
      calls,
    } =
      createRepository();

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    const result =
      await service.upload({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        fileName:
          "sales.csv",

        period:
          "2026-01",

        dataSeries:
          "Monthly Sales",

        content:
          'product,revenue\n"A, quoted",10.10\nB,20.20\n',
      });

    assert.equal(
      result.ingestionRun
        .status,
      "validated",
    );

    assert.equal(
      calls.source.length,
      1,
    );

    assert.equal(
      calls.stream.length,
      1,
    );

    assert.equal(
      calls.registration
        .length,
      1,
    );

    const registration =
      calls.registration[0];

    assert.equal(
      registration.upload
        .rowCount,
      2,
    );

    assert.deepEqual(
      registration.upload
        .columns.map(
          (column) =>
            column.name,
        ),
      [
        "product",
        "revenue",
      ],
    );

    assert.equal(
      registration.upload
        .columns[1]
        .type,
      "decimal",
    );

    assert.equal(
      registration
        .reportingPeriod
        .periodStart,
      "2026-01-01",
    );

    assert.equal(
      registration
        .reportingPeriod
        .periodEnd,
      "2026-01-31",
    );

    assert.equal(
      registration
        .reportingPeriod
        .label,
      "January 2026",
    );

    assert.equal(
      storage.putCalls
        .length,
      1,
    );

    assert.equal(
      storage.deleteCalls
        .length,
      0,
    );

    assert.match(
      storage.putCalls[0]
        .key,
      /^organizations\/org-1\/uploads\/[a-f0-9]{64}\/sales\.csv$/,
    );

    assert.equal(
      storage.putCalls[0]
        .body.toString(
          "utf8",
        ),
      'product,revenue\n"A, quoted",10.10\nB,20.20\n',
    );
  },
);

test(
  "rejected ingestion removes raw bytes written by the current request",
  async () => {
    const {
      repository,
    } =
      createRepository({
        rejected: true,
      });

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    const result =
      await service.upload({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        fileName:
          "sales.csv",

        period:
          "2026-01",

        content:
          "product,revenue\nA,10.00\n",
      });

    assert.equal(
      result.ingestionRun
        .status,
      "rejected",
    );

    assert.equal(
      storage.putCalls
        .length,
      1,
    );

    assert.equal(
      storage.deleteCalls
        .length,
      1,
    );

    assert.equal(
      storage.objects.size,
      0,
    );
  },
);

test(
  "database failure removes an object staged by the current upload",
  async () => {
    const {
      repository,
    } =
      createRepository({
        failRegistration:
          true,
      });

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    await assert.rejects(
      service.upload({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        fileName:
          "sales.csv",

        period:
          "2026-01",

        content:
          "product,revenue\nA,10.00\n",
      }),

      /Database failed/,
    );

    assert.equal(
      storage.putCalls
        .length,
      1,
    );

    assert.equal(
      storage.deleteCalls
        .length,
      1,
    );

    assert.equal(
      storage.objects.size,
      0,
    );
  },
);

test(
  "existing immutable object is not overwritten or deleted by a failed retry",
  async () => {
    const {
      repository,
    } =
      createRepository({
        failRegistration:
          true,
      });

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    const {
      createRawObjectIdentity,
    } =
      await import(
        "../src/ingestion/raw-object-identity.mjs"
      );

    const content =
      "product,revenue\nA,10.00\n";

    const identity =
      createRawObjectIdentity({
        organizationId:
          "org-1",

        originalFilename:
          "sales.csv",

        content,
      });

    storage.objects.set(
      identity.storageKey,
      {
        body:
          Buffer.from(
            content,
          ),

        contentType:
          "text/csv",

        metadata: {},
      },
    );

    await assert.rejects(
      service.upload({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        fileName:
          "sales.csv",

        period:
          "2026-01",

        content,
      }),

      /Database failed/,
    );

    assert.equal(
      storage.putCalls
        .length,
      0,
    );

    assert.equal(
      storage.deleteCalls
        .length,
      0,
    );

    assert.equal(
      storage.objects.size,
      1,
    );
  },
);

test(
  "production ingestion rejects malformed CSV before writing storage",
  async () => {
    const {
      repository,
    } =
      createRepository();

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    await assert.rejects(
      service.upload({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        fileName:
          "bad.csv",

        period:
          "2026-01",

        content:
          "product,revenue\nA,10\nB\n",
      }),

      (error) =>
        error?.code ===
        "VALIDATION_FAILED",
    );

    assert.equal(
      storage.putCalls
        .length,
      0,
    );
  },
);

test(
  "batch ingestion processes multiple tenant files",
  async () => {
    const {
      repository,
    } =
      createRepository();

    const storage =
      new FakeObjectStorage();

    const service =
      new ProductionIngestionService({
        repository,
        objectStorage:
          storage,
      });

    const results =
      await service.uploadBatch({
        organizationId:
          "org-1",

        actorUserId:
          "user-1",

        period:
          "2026-04",

        dataSeries:
          "Store performance",

        files: [
          {
            fileName:
              "store-a.csv",

            content:
              "product,revenue\nA,10.00\n",
          },

          {
            fileName:
              "store-b.csv",

            content:
              "product,revenue\nB,15.00\n",
          },
        ],
      });

    assert.equal(
      results.length,
      2,
    );

    assert.equal(
      storage.putCalls
        .length,
      2,
    );
  },
);