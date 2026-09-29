import {
  createHash,
} from "node:crypto";

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCsvMetrics,
  ProductionWorker,
} from "../src/worker/production-worker.mjs";

class FakeWorkerRepository {
  constructor({
    job,
    context,
  }) {
    this.job =
      job;

    this.context =
      context;

    this.completed =
      [];

    this.failed =
      [];

    this.heartbeats =
      [];
  }

  async heartbeat(
    input,
  ) {
    this.heartbeats.push(
      input,
    );

    return input;
  }

  async leaseNext() {
    const job =
      this.job;

    this.job =
      null;

    return job;
  }

  async getIngestionContext() {
    return this.context;
  }

  async complete(
    input,
  ) {
    this.completed.push(
      input,
    );

    return {
      status:
        "succeeded",
    };
  }

  async fail(
    input,
  ) {
    this.failed.push(
      input,
    );

    return {
      status:
        "failed",
    };
  }
}

class FakeMetricsRepository {
  constructor({
    error = null,
  } = {}) {
    this.error =
      error;

    this.calls =
      [];
  }

  async replaceIngestionMetrics(
    input,
  ) {
    this.calls.push(
      input,
    );

    if (
      this.error
    ) {
      throw this.error;
    }

    return input.metrics;
  }
}

class FakeComparisonRepository {
  constructor({
    error = null,
  } = {}) {
    this.error =
      error;

    this.calls =
      [];
  }

  async refreshForIngestion(
    input,
  ) {
    this.calls.push(
      input,
    );

    if (
      this.error
    ) {
      throw this.error;
    }

    return [
      {
        status:
          "ready",
      },
    ];
  }
}

class FakeFindingsRepository {
  constructor({
    error = null,
  } = {}) {
    this.error =
      error;

    this.calls =
      [];
  }

  async refreshForIngestion(
    input,
  ) {
    this.calls.push(
      input,
    );

    if (
      this.error
    ) {
      throw this.error;
    }

    return [
      {
        findingType:
          "signal",
      },
    ];
  }
}

function verifiedContext({
  content,
  ingestionRunId =
    "run-1",
  rawObjectId =
    "raw-1",
}) {
  return {
    ingestionRunId,

    organizationId:
      "org-1",

    ingestionStatus:
      "validated",

    rawObject: {
      id:
        rawObjectId,

      storageKey:
        `organizations/org-1/uploads/hash/${rawObjectId}.csv`,

      originalFilename:
        "sales.csv",

      contentType:
        "text/csv",

      byteSize:
        content.byteLength,

      checksumSha256:
        createHash(
          "sha256",
        )
          .update(
            content,
          )
          .digest(
            "hex",
          ),

      status:
        "accepted",
    },
  };
}

function durableJob({
  id =
    "job-1",
  ingestionRunId =
    "run-1",
} = {}) {
  return {
    id,

    organizationId:
      "org-1",

    ingestionRunId,

    jobType:
      "ingestion.verify_storage",
  };
}

test(
  "production worker completes only after metrics comparisons and findings succeed",
  async () => {
    const content =
      Buffer.from(
        [
          "product,revenue,cost",
          "A,10.10,4.25",
          "B,20.20,8.50",
          "",
        ].join(
          "\n",
        ),
      );

    const repository =
      new FakeWorkerRepository({
        job:
          durableJob(),

        context:
          verifiedContext({
            content,
          }),
      });

    const metricsRepository =
      new FakeMetricsRepository();

    const comparisonRepository =
      new FakeComparisonRepository();

    const findingsRepository =
      new FakeFindingsRepository();

    const worker =
      new ProductionWorker({
        repository,

        metricsRepository,

        comparisonRepository,

        findingsRepository,

        objectStorage: {
          async getObject() {
            return {
              body:
                content,
            };
          },
        },

        workerId:
          "test-worker",

        heartbeatIntervalMs:
          1_000,
      });

    assert.equal(
      await worker.runOnce(),
      true,
    );

    assert.equal(
      repository.failed.length,
      0,
    );

    assert.equal(
      repository.completed.length,
      1,
    );

    assert.equal(
      metricsRepository.calls.length,
      1,
    );

    assert.equal(
      comparisonRepository.calls.length,
      1,
    );

    assert.equal(
      findingsRepository.calls.length,
      1,
    );

    assert.deepEqual(
      findingsRepository.calls[0],
      {
        organizationId:
          "org-1",

        ingestionRunId:
          "run-1",
      },
    );

    const metrics =
      metricsRepository.calls[0]
        .metrics;

    assert.equal(
      metrics.length,
      2,
    );

    assert.equal(
      metrics.find(
        (
          metric,
        ) =>
          metric.metricKey ===
          "sum:revenue",
      )?.value,
      "30.3",
    );

    assert.equal(
      metrics.find(
        (
          metric,
        ) =>
          metric.metricKey ===
          "sum:cost",
      )?.value,
      "12.75",
    );
  },
);

test(
  "metric extraction excludes identifiers and dates while retaining business measures",
  () => {
    const metrics =
      deriveCsvMetrics({
        body:
          Buffer.from(
            [
              "transaction_id,channel,amount,quantity,transaction_date",
              "1001,Online,125.50,2,2026-09-01",
              "1002,Store,74.50,3,2026-09-02",
              "",
            ].join(
              "\n",
            ),
          ),

        originalFilename:
          "transactions.csv",
      });

    assert.equal(
      metrics.some(
        (
          metric,
        ) =>
          metric.sourceColumn ===
          "transaction_id",
      ),
      false,
    );

    assert.equal(
      metrics.some(
        (
          metric,
        ) =>
          metric.sourceColumn ===
          "transaction_date",
      ),
      false,
    );

    assert.equal(
      metrics.find(
        (
          metric,
        ) =>
          metric.metricKey ===
          "sum:amount",
      )?.value,
      "200",
    );

    const quantity =
      metrics.find(
        (
          metric,
        ) =>
          metric.metricKey ===
          "sum:quantity",
      );

    assert.equal(
      quantity?.value,
      "5",
    );

    assert.equal(
      quantity?.unit,
      "count",
    );
  },
);

test(
  "metric extraction remains decimal exact",
  () => {
    const metrics =
      deriveCsvMetrics({
        body:
          Buffer.from(
            [
              "revenue",
              "0.10",
              "0.20",
              "0.30",
              "",
            ].join(
              "\n",
            ),
          ),

        originalFilename:
          "decimal.csv",
      });

    assert.equal(
      metrics.length,
      1,
    );

    assert.equal(
      metrics[0].value,
      "0.6",
    );
  },
);

test(
  "corrupted immutable raw data fails before metrics comparisons and findings",
  async () => {
    const expected =
      Buffer.from(
        "revenue\n10.00\n",
      );

    const actual =
      Buffer.from(
        "revenue\n99.00\n",
      );

    const context =
      verifiedContext({
        content:
          expected,
      });

    context.rawObject
      .byteSize =
      actual.byteLength;

    const repository =
      new FakeWorkerRepository({
        job:
          durableJob({
            id:
              "job-2",
          }),

        context,
      });

    const metricsRepository =
      new FakeMetricsRepository();

    const comparisonRepository =
      new FakeComparisonRepository();

    const findingsRepository =
      new FakeFindingsRepository();

    const worker =
      new ProductionWorker({
        repository,

        metricsRepository,

        comparisonRepository,

        findingsRepository,

        objectStorage: {
          async getObject() {
            return {
              body:
                actual,
            };
          },
        },

        workerId:
          "test-worker",

        heartbeatIntervalMs:
          1_000,
      });

    assert.equal(
      await worker.runOnce(),
      true,
    );

    assert.equal(
      repository.completed.length,
      0,
    );

    assert.equal(
      repository.failed.length,
      1,
    );

    assert.equal(
      repository.failed[0]
        .error.code,
      "RAW_OBJECT_CHECKSUM_MISMATCH",
    );

    assert.equal(
      metricsRepository.calls.length,
      0,
    );

    assert.equal(
      comparisonRepository.calls.length,
      0,
    );

    assert.equal(
      findingsRepository.calls.length,
      0,
    );
  },
);

test(
  "metric persistence failure leaves the job retryable and blocks later stages",
  async () => {
    const content =
      Buffer.from(
        "revenue\n10.00\n",
      );

    const expectedError =
      new Error(
        "Metric database temporarily unavailable.",
      );

    const repository =
      new FakeWorkerRepository({
        job:
          durableJob({
            id:
              "job-3",

            ingestionRunId:
              "run-3",
          }),

        context:
          verifiedContext({
            content,

            ingestionRunId:
              "run-3",

            rawObjectId:
              "raw-3",
          }),
      });

    const metricsRepository =
      new FakeMetricsRepository({
        error:
          expectedError,
      });

    const comparisonRepository =
      new FakeComparisonRepository();

    const findingsRepository =
      new FakeFindingsRepository();

    const worker =
      new ProductionWorker({
        repository,

        metricsRepository,

        comparisonRepository,

        findingsRepository,

        objectStorage: {
          async getObject() {
            return {
              body:
                content,
            };
          },
        },

        workerId:
          "test-worker",
      });

    assert.equal(
      await worker.runOnce(),
      true,
    );

    assert.equal(
      repository.completed.length,
      0,
    );

    assert.equal(
      repository.failed.length,
      1,
    );

    assert.equal(
      repository.failed[0]
        .error,
      expectedError,
    );

    assert.equal(
      comparisonRepository.calls.length,
      0,
    );

    assert.equal(
      findingsRepository.calls.length,
      0,
    );
  },
);

test(
  "comparison persistence failure leaves the job retryable and blocks findings",
  async () => {
    const content =
      Buffer.from(
        "revenue\n100.00\n",
      );

    const expectedError =
      new Error(
        "Comparison database temporarily unavailable.",
      );

    const repository =
      new FakeWorkerRepository({
        job:
          durableJob({
            id:
              "job-4",

            ingestionRunId:
              "run-4",
          }),

        context:
          verifiedContext({
            content,

            ingestionRunId:
              "run-4",

            rawObjectId:
              "raw-4",
          }),
      });

    const metricsRepository =
      new FakeMetricsRepository();

    const comparisonRepository =
      new FakeComparisonRepository({
        error:
          expectedError,
      });

    const findingsRepository =
      new FakeFindingsRepository();

    const worker =
      new ProductionWorker({
        repository,

        metricsRepository,

        comparisonRepository,

        findingsRepository,

        objectStorage: {
          async getObject() {
            return {
              body:
                content,
            };
          },
        },

        workerId:
          "test-worker",
      });

    assert.equal(
      await worker.runOnce(),
      true,
    );

    assert.equal(
      metricsRepository.calls.length,
      1,
    );

    assert.equal(
      comparisonRepository.calls.length,
      1,
    );

    assert.equal(
      findingsRepository.calls.length,
      0,
    );

    assert.equal(
      repository.completed.length,
      0,
    );

    assert.equal(
      repository.failed.length,
      1,
    );

    assert.equal(
      repository.failed[0]
        .error,
      expectedError,
    );
  },
);

test(
  "findings persistence failure leaves the durable worker job retryable",
  async () => {
    const content =
      Buffer.from(
        "revenue\n125.00\n",
      );

    const expectedError =
      new Error(
        "Findings database temporarily unavailable.",
      );

    const repository =
      new FakeWorkerRepository({
        job:
          durableJob({
            id:
              "job-5",

            ingestionRunId:
              "run-5",
          }),

        context:
          verifiedContext({
            content,

            ingestionRunId:
              "run-5",

            rawObjectId:
              "raw-5",
          }),
      });

    const metricsRepository =
      new FakeMetricsRepository();

    const comparisonRepository =
      new FakeComparisonRepository();

    const findingsRepository =
      new FakeFindingsRepository({
        error:
          expectedError,
      });

    const worker =
      new ProductionWorker({
        repository,

        metricsRepository,

        comparisonRepository,

        findingsRepository,

        objectStorage: {
          async getObject() {
            return {
              body:
                content,
            };
          },
        },

        workerId:
          "test-worker",
      });

    assert.equal(
      await worker.runOnce(),
      true,
    );

    assert.equal(
      metricsRepository.calls.length,
      1,
    );

    assert.equal(
      comparisonRepository.calls.length,
      1,
    );

    assert.equal(
      findingsRepository.calls.length,
      1,
    );

    assert.equal(
      repository.completed.length,
      0,
    );

    assert.equal(
      repository.failed.length,
      1,
    );

    assert.equal(
      repository.failed[0]
        .error,
      expectedError,
    );
  },
);

test(
  "findings repository cannot be configured without comparison repository",
  () => {
    assert.throws(
      () =>
        new ProductionWorker({
          repository:
            new FakeWorkerRepository({
              job:
                null,

              context:
                null,
            }),

          objectStorage: {
            async getObject() {
              return {
                body:
                  Buffer.alloc(
                    0,
                  ),
              };
            },
          },

          metricsRepository:
            new FakeMetricsRepository(),

          findingsRepository:
            new FakeFindingsRepository(),

          workerId:
            "test-worker",
        }),

      /requires a comparison repository/,
    );
  },
);

test(
  "comparison repository cannot be configured without verified metrics",
  () => {
    assert.throws(
      () =>
        new ProductionWorker({
          repository:
            new FakeWorkerRepository({
              job:
                null,

              context:
                null,
            }),

          objectStorage: {
            async getObject() {
              return {
                body:
                  Buffer.alloc(
                    0,
                  ),
              };
            },
          },

          comparisonRepository:
            new FakeComparisonRepository(),

          workerId:
            "test-worker",
        }),

      /requires a metrics repository/,
    );
  },
);

test(
  "production worker stays idle when no durable job is available",
  async () => {
    const repository =
      new FakeWorkerRepository({
        job:
          null,

        context:
          null,
      });

    const worker =
      new ProductionWorker({
        repository,

        objectStorage: {
          async getObject() {
            throw new Error(
              "Should not execute.",
            );
          },
        },

        workerId:
          "test-worker",
      });

    assert.equal(
      await worker.runOnce(),
      false,
    );

    assert.equal(
      repository.completed.length,
      0,
    );

    assert.equal(
      repository.failed.length,
      0,
    );
  },
);