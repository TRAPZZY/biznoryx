import {
  randomUUID,
} from "node:crypto";

import {
  hostname,
} from "node:os";

import pg from "pg";

import {
  PostgresMetricComparisonRepository,
} from "../src/database/metric-comparison-repository.mjs";

import {
  PostgresPerformanceFindingsRepository,
} from "../src/database/performance-findings-repository.mjs";

import {
  PostgresProcessingJobRepository,
} from "../src/database/processing-job-repository.mjs";

import {
  PostgresVerifiedMetricsRepository,
} from "../src/database/verified-metrics-repository.mjs";

import {
  S3ObjectStorage,
} from "../src/storage/s3-object-storage.mjs";

import {
  ProductionWorker,
} from "../src/worker/production-worker.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env
    .DATABASE_URL;

if (
  !connectionString
) {
  throw new Error(
    "DATABASE_URL is required.",
  );
}

const pool =
  new Pool({
    connectionString,

    max:
      integerFromEnv(
        "BIZNORYX_WORKER_DB_POOL_SIZE",
        4,
        1,
        20,
      ),

    idleTimeoutMillis:
      30_000,

    connectionTimeoutMillis:
      10_000,
  });

const repository =
  new PostgresProcessingJobRepository(
    pool,
  );

const metricsRepository =
  new PostgresVerifiedMetricsRepository(
    pool,
  );

const comparisonRepository =
  new PostgresMetricComparisonRepository(
    pool,
  );

const findingsRepository =
  new PostgresPerformanceFindingsRepository(
    pool,
  );

const objectStorage =
  S3ObjectStorage.fromEnv();

const workerId =
  process.env
    .BIZNORYX_WORKER_ID ??
  [
    hostname(),
    process.pid,
    randomUUID().slice(
      0,
      8,
    ),
  ].join(
    ":",
  );

const worker =
  new ProductionWorker({
    repository,

    objectStorage,

    metricsRepository,

    comparisonRepository,

    findingsRepository,

    workerId,

    leaseSeconds:
      integerFromEnv(
        "BIZNORYX_WORKER_LEASE_SECONDS",
        60,
        10,
        900,
      ),

    pollIntervalMs:
      integerFromEnv(
        "BIZNORYX_WORKER_POLL_MS",
        1_000,
        100,
        60_000,
      ),

    heartbeatIntervalMs:
      integerFromEnv(
        "BIZNORYX_WORKER_HEARTBEAT_MS",
        5_000,
        1_000,
        60_000,
      ),

    onError:
      reportWorkerError,
  });

const controller =
  new AbortController();

let stopping =
  false;

process.on(
  "SIGINT",
  shutdown,
);

process.on(
  "SIGTERM",
  shutdown,
);

try {
  await pool.query(
    "select 1",
  );

  await objectStorage
    .healthCheck();

  process.stdout.write(
    `BIZNORYX production worker started: ${workerId}\n`,
  );

  process.stdout.write(
    [
      "Capabilities: raw verification, ",
      "verified metrics, ",
      "historical comparisons, ",
      "verified findings\n",
    ].join(
      "",
    ),
  );

  await worker.run({
    signal:
      controller.signal,
  });
} catch (error) {
  reportWorkerError(
    error,
  );

  process.exitCode =
    1;
} finally {
  await pool.end();
}

async function shutdown() {
  if (
    stopping
  ) {
    return;
  }

  stopping =
    true;

  process.stdout.write(
    `BIZNORYX worker stopping: ${workerId}\n`,
  );

  try {
    await worker.stop();
  } catch (error) {
    reportWorkerError(
      error,
    );
  }

  controller.abort();
}

function reportWorkerError(
  error,
) {
  const name =
    String(
      error?.name ??
        "Error",
    );

  const code =
    String(
      error?.code ??
        "WORKER_ERROR",
    );

  const message =
    String(
      error?.message ??
        "Worker operation failed.",
    )
      .replace(
        /[\r\n\t]+/g,
        " ",
      )
      .replace(
        /(password|secret|token|api[-_ ]?key)\s*[:=]\s*\S+/gi,
        "$1=[redacted]",
      )
      .slice(
        0,
        1800,
      );

  process.stderr.write(
    `[${name}] ${code}: ${message}\n`,
  );
}

function integerFromEnv(
  key,
  fallback,
  minimum,
  maximum,
) {
  const raw =
    process.env[key];

  if (
    raw ===
      undefined ||
    raw ===
      ""
  ) {
    return fallback;
  }

  const value =
    Number(
      raw,
    );

  if (
    !Number.isInteger(
      value,
    ) ||
    value <
      minimum ||
    value >
      maximum
  ) {
    throw new Error(
      `${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}