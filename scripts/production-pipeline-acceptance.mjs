import {
  createHash,
  randomBytes,
} from "node:crypto";

import {
  createServer as createHttpServer,
} from "node:http";

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";

import {
  join,
} from "node:path";

import {
  spawnSync,
} from "node:child_process";

import assert from "node:assert/strict";

import pg from "pg";
import { PostgresBillingRepository } from "../src/database/billing-repository.mjs";

import {
  PostgresIdentityRepository,
} from "../src/database/identity-repository.mjs";

import {
  PostgresEmailVerificationRepository,
} from "../src/database/email-verification-repository.mjs";

import {
  PostgresProcessingJobRepository,
} from "../src/database/processing-job-repository.mjs";

import {
  PostgresVerifiedMetricsRepository,
} from "../src/database/verified-metrics-repository.mjs";

import {
  PostgresMetricComparisonRepository,
} from "../src/database/metric-comparison-repository.mjs";

import {
  PostgresPerformanceFindingsRepository,
} from "../src/database/performance-findings-repository.mjs";

import {
  createRawObjectIdentity,
} from "../src/ingestion/raw-object-identity.mjs";

import {
  S3ObjectStorage,
} from "../src/storage/s3-object-storage.mjs";

import {
  ProductionWorker,
} from "../src/worker/production-worker.mjs";

import {
  createProductionApp,
} from "../src/webapp/production-app.mjs";

const {
  Pool,
} = pg;

const docker =
  process.env.DOCKER_BIN ??
  "docker";

const runtimePassword =
  process.env
    .BIZNORYX_APP_DB_PASSWORD ??
  readLocalEnvironmentValue(
    "BIZNORYX_APP_DB_PASSWORD",
  );

if (
  !runtimePassword
) {
  throw new Error(
    "BIZNORYX_APP_DB_PASSWORD is required.",
  );
}

const nonce =
  randomBytes(
    6,
  ).toString(
    "hex",
  );

const databaseName =
  `biznoryx_pipeline_${nonce}`;

const bucket =
  `biznoryx-acceptance-${nonce}`;

const admin = [
  "compose",
  "exec",
  "-T",
  "postgres",
  "psql",
  "-U",
  "biznoryx_admin",
];

let pool =
  null;

let server =
  null;

let restartedServer =
  null;

let localS3Server =
  null;

let storage =
  null;

const storageKeys =
  [];

try {
  /*
   * ==================================================
   * LOCAL S3-COMPATIBLE ACCEPTANCE ENDPOINT
   * ==================================================
   *
   * The real production S3ObjectStorage adapter is
   * exercised against an isolated HTTP endpoint.
   */

  localS3Server =
    createLocalS3Server({
      bucket,
    });

  await listen(
    localS3Server,
  );

  const storageAddress =
    localS3Server.address();

  if (
    !storageAddress ||
    typeof storageAddress ===
      "string"
  ) {
    throw new Error(
      "Local S3 acceptance server address is unavailable.",
    );
  }

  process.env
    .BIZNORYX_OBJECT_STORAGE_ENDPOINT =
    `http://127.0.0.1:${storageAddress.port}`;

  process.env
    .BIZNORYX_OBJECT_STORAGE_REGION =
    "us-east-1";

  process.env
    .BIZNORYX_OBJECT_STORAGE_BUCKET =
    bucket;

  process.env
    .BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID =
    "BIZNORYX_ACCEPTANCE";

  process.env
    .BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY =
    "BIZNORYX_ACCEPTANCE_SECRET";

  process.env
    .BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE =
    "true";

  process.stdout.write(
    [
      "Local S3-compatible acceptance server listening on ",
      process.env
        .BIZNORYX_OBJECT_STORAGE_ENDPOINT,
      "\n",
    ].join(
      "",
    ),
  );

  /*
   * ==================================================
   * ISOLATED POSTGRES DATABASE
   * ==================================================
   */

  process.stdout.write(
    "Creating isolated production-pipeline database...\n",
  );

  run([
    ...admin,

    "-d",
    "postgres",

    "-v",
    "ON_ERROR_STOP=1",

    "-c",
    `create database ${databaseName}`,
  ]);

  applyMigrations(
    databaseName,
  );

  applyBootstrap(
    databaseName,
    runtimePassword,
  );

  const connectionString =
    [
      "postgresql://biznoryx_app:",
      encodeURIComponent(
        runtimePassword,
      ),
      "@127.0.0.1:5432/",
      databaseName,
    ].join(
      "",
    );

  pool =
    new Pool({
      connectionString,

      max:
        8,

      idleTimeoutMillis:
        30_000,

      connectionTimeoutMillis:
        10_000,
    });

  await pool.query(
    "select 1",
  );

  process.stdout.write(
    "PostgreSQL connection passed.\n",
  );

  /*
   * ==================================================
   * REAL S3 ADAPTER
   * ==================================================
   */

  storage =
    S3ObjectStorage.fromEnv();

  await storage
    .healthCheck();

  process.stdout.write(
    "S3 object-storage health check passed.\n",
  );

  /*
   * ==================================================
   * DETERMINISTIC ACCEPTANCE EMAIL TRANSPORT
   * ==================================================
   */

  let deliveredCode =
    null;

  const emailSender = {
    async sendVerificationCode({
      code,
    }) {
      deliveredCode =
        code;

      return {
        provider:
          "production-pipeline-acceptance",

        messageId:
          `acceptance-${nonce}`,
      };
    },
  };

  /*
   * ==================================================
   * PRODUCTION REPOSITORIES
   * ==================================================
   */

  const identity =
    new PostgresIdentityRepository(
      pool,
      {
        production:
          false,
      },
    );

  const emailVerification =
    new PostgresEmailVerificationRepository(
      pool,
      {
        emailSender,
      },
    );

  const processingJobs =
    new PostgresProcessingJobRepository(
      pool,
    );

  const verifiedMetrics =
    new PostgresVerifiedMetricsRepository(
      pool,
    );

  const metricComparisons =
    new PostgresMetricComparisonRepository(
      pool,
    );

  const performanceFindings =
    new PostgresPerformanceFindingsRepository(
      pool,
    );

  /*
   * ==================================================
   * VERIFIED CUSTOMER
   * ==================================================
   */

  const email =
    `pipeline-${nonce}@example.com`;

  const password =
    `PipelinePass-${nonce}-A7!`;

  const user =
    await identity
      .createUser({
        email,

        displayName:
          "Production Pipeline Acceptance",

        password,
      });

  await emailVerification
    .issue({
      email,

      actorUserId:
        user.id,
    });

  assert.ok(
    deliveredCode,
    "Verification code was not delivered.",
  );

  await emailVerification
    .verify({
      email,
      newPassword: password,

      code:
        deliveredCode,
    });

  process.stdout.write(
    "Verified production identity passed.\n",
  );

  /*
   * ==================================================
   * PRODUCTION APPLICATION
   * ==================================================
   */

  const app =
    createProductionApp({
      pool,

      identityRepository:
        identity,

      emailVerificationRepository:
        emailVerification,

      processingJobRepository:
        processingJobs,

      verifiedMetricsRepository:
        verifiedMetrics,

      metricComparisonRepository:
        metricComparisons,

      performanceFindingsRepository:
        performanceFindings,

      objectStorage:
        storage,

      production:
        false,
    });

  server =
    app.server;

  await listen(
    server,
  );

  const client =
    createApiClient(
      serverUrl(
        server,
      ),
    );

  /*
   * ==================================================
   * SIGN IN
   * ==================================================
   */

  const signedIn =
    await client.call(
      "/api/sign-in",
      {
        method:
          "POST",

        body: {
          email,
          password,
        },
      },
    );

  assert.equal(
    signedIn.status,
    200,
    JSON.stringify(
      signedIn.body,
    ),
  );

  assert.equal(
    signedIn.body
      .authenticated,
    true,
  );

  assert.ok(
    signedIn.body
      .csrfToken,
  );

  client.setCsrfToken(
    signedIn.body
      .csrfToken,
  );

  const policy = await client.call("/api/account/policy-acceptance", {
    method: "POST", body: { termsAccepted: true, privacyAccepted: true, dataAuthorityAccepted: true, guideAcknowledged: true },
  });
  assert.equal(policy.status, 200, JSON.stringify(policy.body));

  process.stdout.write(
    "Production sign-in passed.\n",
  );

  /*
   * ==================================================
   * TENANT
   * ==================================================
   */

  const organizationName =
    `Pipeline Acceptance ${nonce}`;

  const createdOrganization =
    await client.call(
      "/api/organizations",
      {
        method:
          "POST",

        body: {
          name:
            organizationName,
        },
      },
    );

  assert.equal(
    createdOrganization.status,
    201,
    JSON.stringify(
      createdOrganization.body,
    ),
  );

  const organizationId =
    createdOrganization.body
      .organization
      .id;

  assert.ok(
    organizationId,
  );

  // Synthetic paid entitlement for this disposable ingestion acceptance tenant.
  // No Paystack request or real payment is made by the pipeline fixture.
  const billing = new PostgresBillingRepository(pool);
  await billing.ensureSubscription({ organizationId, actorUserId: user.id });
  const checkout = await billing.createCheckoutSession({ organizationId, actorUserId: user.id,
    provider: "paystack", reference: `acceptance-paid-${nonce}`, authorizationUrl: "https://checkout.paystack.com/test", accessCode: "synthetic" });
  await billing.applyWebhookEvent({ organizationId, reference: checkout.reference, eventKey: `acceptance-paid-${nonce}`,
    eventName: "charge.success", payload: Buffer.from("{}"), action: "subscription_activated", paidAt: new Date() });

  /*
   * ==================================================
   * BUSINESS ONBOARDING
   * ==================================================
   */

  const profile =
    await client.call(
      "/api/onboarding/profile",
      {
        method:
          "POST",

        body: {
          legalName:
            organizationName,

          tradingName:
            organizationName,

          industry:
            "Technology",

          businessModel:
            "Software as a service",

          primaryCurrency:
            "USD",

          fiscalYearStartMonth:
            1,

          timezone:
            "UTC",
        },
      },
    );

  assert.equal(
    profile.status,
    200,
    JSON.stringify(
      profile.body,
    ),
  );

  /*
   * ==================================================
   * BASELINE DASHBOARD
   * ==================================================
   */

  const baseline =
    await client.call(
      "/api/dashboard",
    );

  assert.equal(
    baseline.status,
    200,
  );

  assert.deepEqual(
    baseline.body
      .uploads,
    [],
  );

  assert.deepEqual(
    baseline.body
      .series,
    [],
  );

  assert.deepEqual(
    baseline.body
      .seriesGroups,
    [],
  );

  assert.deepEqual(
    baseline.body
      .trendRows,
    [],
  );

  assert.deepEqual(
    baseline.body
      .signals,
    [],
  );

  assert.deepEqual(
    baseline.body
      .risks,
    [],
  );

  assert.deepEqual(
    baseline.body
      .opportunities,
    [],
  );

  assert.deepEqual(
    baseline.body
      .focusAreas,
    [],
  );

  /*
   * ==================================================
   * RECURRING DATA SERIES
   * ==================================================
   */

  const dataSeries =
    `Pipeline Revenue ${nonce}`;

  /*
   * ==================================================
   * PERIOD 1 — JANUARY
   * ==================================================
   *
   * Revenue:
   *
   * 40 + 60 = 100
   */

  const januaryFileName =
    `pipeline-january-${nonce}.csv`;

  const januaryCsv =
    [
      "product,revenue,date",
      `Product-A-${nonce},40.00,2026-01-01`,
      `Product-B-${nonce},60.00,2026-01-02`,
      "",
    ].join(
      "\n",
    );

  const januaryIdentity =
    createRawObjectIdentity({
      organizationId,

      originalFilename:
        januaryFileName,

      content:
        januaryCsv,
    });

  storageKeys.push(
    januaryIdentity
      .storageKey,
  );

  const januaryUploadResult =
    await client.call(
      "/api/ingestion/upload",
      {
        method:
          "POST",

        body: {
          fileName:
            januaryFileName,

          period:
            "2026-01",

          dataSeries,

          content:
            januaryCsv,
        },
      },
    );

  assert.equal(
    januaryUploadResult.status,
    200,
    JSON.stringify(
      januaryUploadResult.body,
    ),
  );

  const januaryUpload =
    januaryUploadResult.body
      .upload;

  assert.ok(
    januaryUpload,
  );

  assert.equal(
    januaryUpload.status,
    "validated",
  );

  assert.equal(
    januaryUpload.period,
    "2026-01",
  );

  assert.equal(
    januaryUpload.rowCount,
    2,
  );

  assert.equal(
    januaryUpload.columnCount,
    3,
  );

  assert.equal(
    januaryUpload.checksumSha256,
    januaryIdentity
      .checksumSha256,
  );

  await assertStoredObject({
    storage,

    storageKey:
      januaryIdentity
        .storageKey,

    expectedContent:
      januaryCsv,

    expectedChecksum:
      januaryIdentity
        .checksumSha256,
  });

  /*
   * January durable job.
   */

  const januaryQueued =
    await latestJobForOrganization({
      pool,
      organizationId,
    });

  assert.equal(
    januaryQueued.status,
    "queued",
  );

  assert.equal(
    januaryQueued.job_type,
    "ingestion.verify_storage",
  );

  /*
   * Before the worker executes:
   *
   * upload exists
   * metrics absent
   * comparison absent
   * findings absent
   */

  const januaryBeforeWorker =
    await client.call(
      "/api/dashboard",
    );

  assert.equal(
    januaryBeforeWorker.status,
    200,
  );

  assert.equal(
    januaryBeforeWorker.body
      .uploads
      .length,
    1,
  );

  assert.equal(
    januaryBeforeWorker.body
      .series
      .length,
    0,
  );

  assert.equal(
    januaryBeforeWorker.body
      .trendRows
      .length,
    0,
  );

  assert.equal(
    januaryBeforeWorker.body
      .signals
      .length,
    0,
  );

  assert.equal(
    januaryBeforeWorker.body
      .risks
      .length,
    0,
  );

  assert.equal(
    januaryBeforeWorker.body
      .opportunities
      .length,
    0,
  );

  assert.equal(
    januaryBeforeWorker.body
      .focusAreas
      .length,
    0,
  );

  /*
   * ==================================================
   * REAL PRODUCTION WORKER
   * ==================================================
   */

  const workerErrors =
    [];

  const worker =
    new ProductionWorker({
      repository:
        processingJobs,

      objectStorage:
        storage,

      metricsRepository:
        verifiedMetrics,

      comparisonRepository:
        metricComparisons,

      findingsRepository:
        performanceFindings,

      workerId:
        `pipeline-worker-${nonce}`,

      leaseSeconds:
        60,

      heartbeatIntervalMs:
        1_000,

      onError(
        error,
      ) {
        workerErrors.push(
          error,
        );
      },
    });

  /*
   * Process January.
   */

  assert.equal(
    await worker.runOnce(),
    true,
  );

  assert.equal(
    workerErrors.length,
    0,
    describeErrors(
      workerErrors,
    ),
  );

  await assertSucceededJob({
    pool,

    jobId:
      januaryQueued.id,

    expectedAttempts:
      1,
  });

  /*
   * ==================================================
   * JANUARY DASHBOARD
   * ==================================================
   *
   * The first verified period creates a metric and
   * not_ready comparison.
   *
   * It must NOT create performance findings.
   */

  const januaryDashboard =
    await client.call(
      "/api/dashboard",
    );

  assert.equal(
    januaryDashboard.status,
    200,
    JSON.stringify(
      januaryDashboard.body,
    ),
  );

  assert.equal(
    januaryDashboard.body
      .uploads
      .length,
    1,
  );

  assert.equal(
    januaryDashboard.body
      .series
      .length,
    1,
  );

  assert.equal(
    januaryDashboard.body
      .seriesGroups
      .length,
    1,
  );

  assert.equal(
    januaryDashboard.body
      .trendRows
      .length,
    1,
  );

  assert.equal(
    januaryDashboard.body
      .signals
      .length,
    0,
  );

  assert.equal(
    januaryDashboard.body
      .risks
      .length,
    0,
  );

  assert.equal(
    januaryDashboard.body
      .opportunities
      .length,
    0,
  );

  assert.equal(
    januaryDashboard.body
      .focusAreas
      .length,
    0,
  );

  const januaryRevenue =
    januaryDashboard.body
      .series
      .find(
        (
          item,
        ) =>
          item.metricKey ===
          "sum:revenue",
      );

  assert.ok(
    januaryRevenue,
  );

  assert.equal(
    januaryRevenue.points
      .length,
    1,
  );

  assert.equal(
    januaryRevenue.points[0]
      .value,
    "100",
  );

  const januaryTrend =
    januaryDashboard.body
      .trendRows
      .find(
        (
          row,
        ) =>
          row.metricKey ===
          "sum:revenue",
      );

  assert.ok(
    januaryTrend,
  );

  assert.equal(
    januaryTrend.status,
    "not_ready",
  );

  assert.equal(
    januaryTrend.direction,
    "not_ready",
  );

  assert.equal(
    januaryTrend.previousValue,
    null,
  );

  assert.equal(
    januaryTrend.currentValue,
    "100",
  );

  assert.equal(
    januaryTrend.absoluteChange,
    null,
  );

  assert.equal(
    januaryTrend.percentChange,
    null,
  );

  assert.equal(
    januaryTrend
      .currentPeriod
      .label,
    "January 2026",
  );

  assert.equal(
    januaryTrend
      .evidence
      .currentRawDataObjectId,
    januaryUpload
      .rawObjectId,
  );

  process.stdout.write(
    "First-period metric and not-ready trend passed.\n",
  );

  process.stdout.write(
    "First-period no-findings rule passed.\n",
  );

  /*
   * ==================================================
   * PERIOD 2 — FEBRUARY
   * ==================================================
   *
   * Revenue:
   *
   * 50 + 75 = 125
   *
   * Comparison:
   *
   * previous = 100
   * current  = 125
   * absolute = +25
   * percent  = +25%
   *
   * Revenue is explicitly higher_is_better in the
   * deterministic findings semantic allowlist.
   *
   * Therefore the ready comparison can generate:
   *
   * signal
   * opportunity
   * focus_area
   *
   * It must NOT generate a risk.
   */

  const februaryFileName =
    `pipeline-february-${nonce}.csv`;

  const februaryCsv =
    [
      "product,revenue,date",
      `Product-A-${nonce},50.00,2026-02-01`,
      `Product-B-${nonce},75.00,2026-02-02`,
      "",
    ].join(
      "\n",
    );

  const februaryIdentity =
    createRawObjectIdentity({
      organizationId,

      originalFilename:
        februaryFileName,

      content:
        februaryCsv,
    });

  storageKeys.push(
    februaryIdentity
      .storageKey,
  );

  const februaryUploadResult =
    await client.call(
      "/api/ingestion/upload",
      {
        method:
          "POST",

        body: {
          fileName:
            februaryFileName,

          period:
            "2026-02",

          dataSeries,

          content:
            februaryCsv,
        },
      },
    );

  assert.equal(
    februaryUploadResult.status,
    200,
    JSON.stringify(
      februaryUploadResult.body,
    ),
  );

  const februaryUpload =
    februaryUploadResult.body
      .upload;

  assert.ok(
    februaryUpload,
  );

  assert.equal(
    februaryUpload.status,
    "validated",
  );

  assert.equal(
    februaryUpload.period,
    "2026-02",
  );

  assert.equal(
    februaryUpload.rowCount,
    2,
  );

  assert.equal(
    februaryUpload.columnCount,
    3,
  );

  assert.equal(
    februaryUpload.checksumSha256,
    februaryIdentity
      .checksumSha256,
  );

  await assertStoredObject({
    storage,

    storageKey:
      februaryIdentity
        .storageKey,

    expectedContent:
      februaryCsv,

    expectedChecksum:
      februaryIdentity
        .checksumSha256,
  });

  const februaryQueued =
    await latestJobForOrganization({
      pool,
      organizationId,
    });

  assert.notEqual(
    februaryQueued.id,
    januaryQueued.id,
  );

  assert.equal(
    februaryQueued.status,
    "queued",
  );

  /*
   * Before February worker processing, January
   * remains the latest verified state.
   */

  const februaryBeforeWorker =
    await client.call(
      "/api/dashboard",
    );

  assert.equal(
    februaryBeforeWorker.status,
    200,
  );

  assert.equal(
    februaryBeforeWorker.body
      .uploads
      .length,
    2,
  );

  assert.equal(
    februaryBeforeWorker.body
      .series
      .length,
    1,
  );

  assert.equal(
    februaryBeforeWorker.body
      .trendRows
      .length,
    1,
  );

  assert.equal(
    februaryBeforeWorker.body
      .trendRows[0]
      .status,
    "not_ready",
  );

  assert.equal(
    februaryBeforeWorker.body
      .signals
      .length,
    0,
  );

  assert.equal(
    februaryBeforeWorker.body
      .risks
      .length,
    0,
  );

  assert.equal(
    februaryBeforeWorker.body
      .opportunities
      .length,
    0,
  );

  assert.equal(
    februaryBeforeWorker.body
      .focusAreas
      .length,
    0,
  );

  /*
   * Process February.
   */

  assert.equal(
    await worker.runOnce(),
    true,
  );

  assert.equal(
    workerErrors.length,
    0,
    describeErrors(
      workerErrors,
    ),
  );

  await assertSucceededJob({
    pool,

    jobId:
      februaryQueued.id,

    expectedAttempts:
      1,
  });

  /*
   * ==================================================
   * FINAL PRODUCTION DASHBOARD
   * ==================================================
   */

  const dashboard =
    await client.call(
      "/api/dashboard",
    );

  assert.equal(
    dashboard.status,
    200,
    JSON.stringify(
      dashboard.body,
    ),
  );

  /*
   * Upload history.
   */

  assert.equal(
    dashboard.body
      .uploads
      .length,
    2,
  );

  /*
   * Verified metric history.
   */

  assert.equal(
    dashboard.body
      .series
      .length,
    1,
  );

  assert.equal(
    dashboard.body
      .seriesGroups
      .length,
    1,
  );

  const revenueSeries =
    dashboard.body
      .series
      .find(
        (
          item,
        ) =>
          item.metricKey ===
          "sum:revenue",
      );

  assert.ok(
    revenueSeries,
  );

  assert.equal(
    revenueSeries.points
      .length,
    2,
  );

  assert.deepEqual(
    revenueSeries.points
      .map(
        (
          point,
        ) =>
          point.value,
      ),
    [
      "100",
      "125",
    ],
  );

  assert.deepEqual(
    revenueSeries.points
      .map(
        (
          point,
        ) =>
          reportingMonth(
            point.periodStart,
          ),
      ),
    [
      "2026-01",
      "2026-02",
    ],
  );

  /*
   * Verified comparison.
   */

  assert.equal(
    dashboard.body
      .trendRows
      .length,
    1,
  );

  const trend =
    dashboard.body
      .trendRows
      .find(
        (
          row,
        ) =>
          row.metricKey ===
          "sum:revenue",
      );

  assert.ok(
    trend,
  );

  assert.equal(
    trend.status,
    "ready",
  );

  assert.equal(
    trend.direction,
    "up",
  );

  assert.equal(
    trend.previousValue,
    "100",
  );

  assert.equal(
    trend.currentValue,
    "125",
  );

  assert.equal(
    trend.absoluteChange,
    "25",
  );

  assert.equal(
    trend.percentChange,
    "25",
  );

  assert.equal(
    trend
      .previousPeriod
      .label,
    "January 2026",
  );

  assert.equal(
    trend
      .currentPeriod
      .label,
    "February 2026",
  );

  assert.equal(
    trend
      .evidence
      .previousRawDataObjectId,
    januaryUpload
      .rawObjectId,
  );

  assert.equal(
    trend
      .evidence
      .currentRawDataObjectId,
    februaryUpload
      .rawObjectId,
  );

  /*
   * ==================================================
   * VERIFIED PERFORMANCE FINDINGS
   * ==================================================
   */

  assert.equal(
    dashboard.body
      .signals
      .length,
    1,
  );

  assert.equal(
    dashboard.body
      .risks
      .length,
    0,
  );

  assert.equal(
    dashboard.body
      .opportunities
      .length,
    1,
  );

  assert.equal(
    dashboard.body
      .focusAreas
      .length,
    1,
  );

  const revenueSignal =
    dashboard.body
      .signals[0];

  assert.equal(
    revenueSignal.findingType,
    "signal",
  );

  assert.equal(
    revenueSignal
      .metric
      .key,
    "sum:revenue",
  );

  assert.equal(
    revenueSignal.severity,
    "high",
  );

  assert.equal(
    revenueSignal.status,
    "active",
  );

  assert.equal(
    revenueSignal
      .reportingPeriod
      .label,
    "February 2026",
  );

  assert.equal(
    revenueSignal
      .evidence
      .metricPolarity,
    "higher_is_better",
  );

  assert.equal(
    revenueSignal
      .evidence
      .direction,
    "up",
  );

  assert.equal(
    revenueSignal
      .evidence
      .previousValue,
    "100",
  );

  assert.equal(
    revenueSignal
      .evidence
      .currentValue,
    "125",
  );

  assert.equal(
    revenueSignal
      .evidence
      .absoluteChange,
    "25",
  );

  assert.equal(
    revenueSignal
      .evidence
      .percentChange,
    "25",
  );

  assert.equal(
    revenueSignal
      .evidence
      .previousRawDataObjectId,
    januaryUpload
      .rawObjectId,
  );

  assert.equal(
    revenueSignal
      .evidence
      .currentRawDataObjectId,
    februaryUpload
      .rawObjectId,
  );

  const revenueOpportunity =
    dashboard.body
      .opportunities[0];

  assert.equal(
    revenueOpportunity.findingType,
    "opportunity",
  );

  assert.equal(
    revenueOpportunity
      .metric
      .key,
    "sum:revenue",
  );

  assert.equal(
    revenueOpportunity.severity,
    "high",
  );

  assert.equal(
    revenueOpportunity
      .evidence
      .interpretation,
    "opportunity",
  );

  assert.equal(
    revenueOpportunity
      .evidence
      .semanticRule,
    "deterministic_metric_semantics_v1",
  );

  assert.equal(
    revenueOpportunity
      .evidence
      .previousRawDataObjectId,
    januaryUpload
      .rawObjectId,
  );

  assert.equal(
    revenueOpportunity
      .evidence
      .currentRawDataObjectId,
    februaryUpload
      .rawObjectId,
  );

  const revenueFocusArea =
    dashboard.body
      .focusAreas[0];

  assert.equal(
    revenueFocusArea.findingType,
    "focus_area",
  );

  assert.equal(
    revenueFocusArea
      .metric
      .key,
    "sum:revenue",
  );

  assert.equal(
    revenueFocusArea.severity,
    "high",
  );

  assert.equal(
    revenueFocusArea
      .evidence
      .interpretation,
    "review_required",
  );

  process.stdout.write(
    "Second-period verified historical comparison passed.\n",
  );

  process.stdout.write(
    "Verified performance signal passed.\n",
  );

  process.stdout.write(
    "Verified opportunity passed.\n",
  );

  process.stdout.write(
    "Verified focus area passed.\n",
  );

  process.stdout.write(
    "Unsupported risk fabrication prevented.\n",
  );

  /*
   * ==================================================
   * DIRECT FINDINGS DATABASE ACCEPTANCE
   * ==================================================
   */

  const findingsClient =
    await pool.connect();

  try {
    await findingsClient
      .query(
        "begin",
      );

    await findingsClient
      .query(
        `select set_config(
           'app.current_organization_id',
           $1,
           true
         )`,
        [
          organizationId,
        ],
      );

    const findingRows =
      await findingsClient
        .query(
          `select
             pf.finding_type,
             pf.severity,
             pf.status,
             pf.title,
             pf.summary,
             pf.source_comparison_id,
             pf.evidence,

             md.metric_key,
             rp.period_start,
             rp.label as period_label

           from verified_performance_findings pf

           join verified_metric_definitions md
             on md.id =
               pf.metric_definition_id

           join reporting_periods rp
             on rp.id =
               pf.current_reporting_period_id

           where pf.organization_id = $1
             and md.metric_key =
               'sum:revenue'

           order by
             pf.finding_type asc`,
          [
            organizationId,
          ],
        );

    assert.equal(
      findingRows.rows.length,
      3,
    );

    assert.deepEqual(
      findingRows.rows
        .map(
          (
            row,
          ) =>
            row.finding_type,
        )
        .sort(),
      [
        "focus_area",
        "opportunity",
        "signal",
      ],
    );

    for (
      const row of
        findingRows.rows
    ) {
      assert.equal(
        row.status,
        "active",
      );

      assert.equal(
        row.severity,
        "high",
      );

      assert.ok(
        row
          .source_comparison_id,
      );

      assert.equal(
        row.metric_key,
        "sum:revenue",
      );

      assert.equal(
        reportingMonth(
          row.period_start,
        ),
        "2026-02",
      );

      assert.equal(
        row.period_label,
        "February 2026",
      );

      assert.equal(
        row.evidence
          .previousValue,
        "100",
      );

      assert.equal(
        row.evidence
          .currentValue,
        "125",
      );

      assert.equal(
        row.evidence
          .absoluteChange,
        "25",
      );

      assert.equal(
        row.evidence
          .percentChange,
        "25",
      );

      assert.equal(
        row.evidence
          .previousRawDataObjectId,
        januaryUpload
          .rawObjectId,
      );

      assert.equal(
        row.evidence
          .currentRawDataObjectId,
        februaryUpload
          .rawObjectId,
      );
    }

    const januaryFindingCount =
      await findingsClient
        .query(
          `select
             count(*)::integer as count

           from verified_performance_findings pf

           join reporting_periods rp
             on rp.id =
               pf.current_reporting_period_id

           where pf.organization_id = $1
             and rp.period_start =
               date '2026-01-01'`,
          [
            organizationId,
          ],
        );

    assert.equal(
      Number(
        januaryFindingCount
          .rows[0]
          .count,
      ),
      0,
    );

    await findingsClient
      .query(
        "rollback",
      );
  } catch (error) {
    try {
      await findingsClient
        .query(
          "rollback",
        );
    } catch {
      /*
       * Preserve original acceptance failure.
       */
    }

    throw error;
  } finally {
    findingsClient
      .release();
  }

  process.stdout.write(
    "Durable findings database state passed.\n",
  );

  /*
   * ==================================================
   * READINESS
   * ==================================================
   */

  const ready =
    await client.call(
      "/readyz",
    );

  assert.equal(
    ready.status,
    200,
    JSON.stringify(
      ready.body,
    ),
  );

  assert.equal(
    ready.body
      .status,
    "ready",
  );

  assert.ok(
    ready.body
      .checks,
  );

  process.stdout.write(
    "Production readiness passed.\n",
  );

  /*
   * ==================================================
   * APPLICATION RESTART
   * ==================================================
   */

  await closeServer(
    server,
  );

  server =
    null;

  const restartedApp =
    createProductionApp({
      pool,

      identityRepository:
        identity,

      emailVerificationRepository:
        emailVerification,

      processingJobRepository:
        processingJobs,

      verifiedMetricsRepository:
        verifiedMetrics,

      metricComparisonRepository:
        metricComparisons,

      performanceFindingsRepository:
        performanceFindings,

      objectStorage:
        storage,

      production:
        false,
    });

  restartedServer =
    restartedApp.server;

  await listen(
    restartedServer,
  );

  const restartedClient =
    createApiClient(
      serverUrl(
        restartedServer,
      ),
      {
        cookie:
          client.getCookie(),
      },
    );

  /*
   * ==================================================
   * RESTART DURABILITY
   * ==================================================
   */

  const afterRestart =
    await restartedClient.call(
      "/api/dashboard",
    );

  assert.equal(
    afterRestart.status,
    200,
    JSON.stringify(
      afterRestart.body,
    ),
  );

  assert.equal(
    afterRestart.body
      .uploads
      .length,
    2,
  );

  assert.equal(
    afterRestart.body
      .series
      .length,
    1,
  );

  assert.equal(
    afterRestart.body
      .series[0]
      .points
      .length,
    2,
  );

  assert.equal(
    afterRestart.body
      .trendRows
      .length,
    1,
  );

  const restartedTrend =
    afterRestart.body
      .trendRows[0];

  assert.equal(
    restartedTrend.status,
    "ready",
  );

  assert.equal(
    restartedTrend.direction,
    "up",
  );

  assert.equal(
    restartedTrend.previousValue,
    "100",
  );

  assert.equal(
    restartedTrend.currentValue,
    "125",
  );

  assert.equal(
    restartedTrend.absoluteChange,
    "25",
  );

  assert.equal(
    restartedTrend.percentChange,
    "25",
  );

  /*
   * Findings must survive application restart.
   */

  assert.equal(
    afterRestart.body
      .signals
      .length,
    1,
  );

  assert.equal(
    afterRestart.body
      .risks
      .length,
    0,
  );

  assert.equal(
    afterRestart.body
      .opportunities
      .length,
    1,
  );

  assert.equal(
    afterRestart.body
      .focusAreas
      .length,
    1,
  );

  const restartedSignal =
    afterRestart.body
      .signals[0];

  const restartedOpportunity =
    afterRestart.body
      .opportunities[0];

  const restartedFocusArea =
    afterRestart.body
      .focusAreas[0];

  assert.equal(
    restartedSignal
      .metric
      .key,
    "sum:revenue",
  );

  assert.equal(
    restartedSignal
      .evidence
      .previousValue,
    "100",
  );

  assert.equal(
    restartedSignal
      .evidence
      .currentValue,
    "125",
  );

  assert.equal(
    restartedSignal
      .evidence
      .previousRawDataObjectId,
    januaryUpload
      .rawObjectId,
  );

  assert.equal(
    restartedSignal
      .evidence
      .currentRawDataObjectId,
    februaryUpload
      .rawObjectId,
  );

  assert.equal(
    restartedOpportunity
      .findingType,
    "opportunity",
  );

  assert.equal(
    restartedOpportunity
      .evidence
      .metricPolarity,
    "higher_is_better",
  );

  assert.equal(
    restartedOpportunity
      .evidence
      .semanticRule,
    "deterministic_metric_semantics_v1",
  );

  assert.equal(
    restartedFocusArea
      .findingType,
    "focus_area",
  );

  assert.equal(
    restartedFocusArea
      .evidence
      .interpretation,
    "review_required",
  );

  /*
   * Both durable jobs remain succeeded.
   */

  await assertSucceededJob({
    pool,

    jobId:
      januaryQueued.id,

    expectedAttempts:
      1,
  });

  await assertSucceededJob({
    pool,

    jobId:
      februaryQueued.id,

    expectedAttempts:
      1,
  });

  /*
   * Recent worker heartbeat keeps readiness healthy.
   */

  const readyAfterRestart =
    await restartedClient.call(
      "/readyz",
    );

  assert.equal(
    readyAfterRestart.status,
    200,
    JSON.stringify(
      readyAfterRestart.body,
    ),
  );

  assert.equal(
    readyAfterRestart.body
      .status,
    "ready",
  );

  process.stdout.write(
    "Restart-safe verified findings passed.\n",
  );

  /*
   * ==================================================
   * FINAL RESULT
   * ==================================================
   */

  process.stdout.write(
    "\n",
  );

  process.stdout.write(
    "BIZNORYX VERIFIED INTELLIGENCE PIPELINE ACCEPTANCE PASSED.\n",
  );

  process.stdout.write(
    "database ........................ PASS\n",
  );

  process.stdout.write(
    "tenant identity ................. PASS\n",
  );

  process.stdout.write(
    "business onboarding ............. PASS\n",
  );

  process.stdout.write(
    "S3 adapter ...................... PASS\n",
  );

  process.stdout.write(
    "January raw object .............. PASS\n",
  );

  process.stdout.write(
    "January durable worker .......... PASS\n",
  );

  process.stdout.write(
    "January verified metric ......... PASS\n",
  );

  process.stdout.write(
    "January trend not-ready ......... PASS\n",
  );

  process.stdout.write(
    "January findings empty .......... PASS\n",
  );

  process.stdout.write(
    "February raw object ............. PASS\n",
  );

  process.stdout.write(
    "February durable worker ......... PASS\n",
  );

  process.stdout.write(
    "February verified metric ........ PASS\n",
  );

  process.stdout.write(
    "historical comparison ........... PASS\n",
  );

  process.stdout.write(
    "finding signal .................. PASS\n",
  );

  process.stdout.write(
    "finding opportunity ............. PASS\n",
  );

  process.stdout.write(
    "finding focus area .............. PASS\n",
  );

  process.stdout.write(
    "unsupported risk prevented ...... PASS\n",
  );

  process.stdout.write(
    "finding evidence links .......... PASS\n",
  );

  process.stdout.write(
    "dashboard findings .............. PASS\n",
  );

  process.stdout.write(
    "restart findings persistence .... PASS\n",
  );

  process.stdout.write(
    "readiness ....................... PASS\n",
  );
} finally {
  /*
   * ==================================================
   * CLEANUP
   * ==================================================
   */

  if (
    restartedServer
  ) {
    await closeServer(
      restartedServer,
    );
  }

  if (
    server
  ) {
    await closeServer(
      server,
    );
  }

  if (
    storage
  ) {
    for (
      const storageKey of
        storageKeys
    ) {
      try {
        await storage
          .deleteObject({
            key:
              storageKey,
          });
      } catch {
        /*
         * Continue remaining cleanup.
         */
      }
    }
  }

  if (
    pool
  ) {
    await pool.end();
  }

  if (
    localS3Server
  ) {
    await closeServer(
      localS3Server,
    );
  }

  run(
    [
      ...admin,

      "-d",
      "postgres",

      "-v",
      "ON_ERROR_STOP=1",

      "-c",
      `drop database if exists ${databaseName} with (force)`,
    ],
    {
      allowFailure:
        true,
    },
  );
}

/*
 * ==================================================
 * DATABASE ASSERTION HELPERS
 * ==================================================
 */

async function latestJobForOrganization({
  pool,
  organizationId,
}) {
  const result =
    await pool.query(
      `select
         id,
         organization_id,
         ingestion_run_id,
         job_type,
         status,
         attempts
       from processing_jobs
       where organization_id = $1
       order by
         created_at desc,
         id desc
       limit 1`,
      [
        organizationId,
      ],
    );

  assert.equal(
    result.rows.length,
    1,
  );

  return result.rows[0];
}

async function assertSucceededJob({
  pool,
  jobId,
  expectedAttempts,
}) {
  const result =
    await pool.query(
      `select
         status,
         attempts,
         completed_at,
         last_error
       from processing_jobs
       where id = $1
       limit 1`,
      [
        jobId,
      ],
    );

  assert.equal(
    result.rows.length,
    1,
  );

  assert.equal(
    result.rows[0]
      .status,
    "succeeded",
  );

  assert.equal(
    Number(
      result.rows[0]
        .attempts,
    ),
    expectedAttempts,
  );

  assert.ok(
    result.rows[0]
      .completed_at,
  );

  assert.equal(
    result.rows[0]
      .last_error,
    null,
  );
}

async function assertStoredObject({
  storage,
  storageKey,
  expectedContent,
  expectedChecksum,
}) {
  const stored =
    await storage
      .getObject({
        key:
          storageKey,
      });

  assert.ok(
    Buffer.isBuffer(
      stored.body,
    ),
    "S3 adapter did not return a Buffer.",
  );

  assert.equal(
    stored.body.toString(
      "utf8",
    ),
    expectedContent,
  );

  const checksum =
    createHash(
      "sha256",
    )
      .update(
        stored.body,
      )
      .digest(
        "hex",
      );

  assert.equal(
    checksum,
    expectedChecksum,
  );
}

function describeErrors(
  errors,
) {
  return errors
    .map(
      (
        error,
      ) =>
        [
          error?.code ??
            error?.name ??
            "Error",
          ": ",
          error?.message ??
            "Unknown error",
        ].join(
          "",
        ),
    )
    .join(
      "\n",
    );
}

/*
 * ==================================================
 * LOCAL S3-COMPATIBLE SERVER
 * ==================================================
 */

function createLocalS3Server({
  bucket,
}) {
  const objects =
    new Map();

  return createHttpServer(
    async (
      request,
      response,
    ) => {
      try {
        const url =
          new URL(
            request.url ??
              "/",

            `http://${request.headers.host ?? "127.0.0.1"}`,
          );

        const segments =
          url.pathname
            .split(
              "/",
            )
            .filter(
              Boolean,
            )
            .map(
              decodeURIComponent,
            );

        /*
         * ListBuckets.
         */

        if (
          segments.length ===
          0
        ) {
          if (
            request.method ===
            "GET"
          ) {
            sendXml(
              response,
              200,
              listBucketsXml(
                bucket,
              ),
            );

            return;
          }

          sendS3Error(
            response,
            405,
            "MethodNotAllowed",
            "Method not allowed.",
          );

          return;
        }

        const requestedBucket =
          segments[0];

        if (
          requestedBucket !==
          bucket
        ) {
          sendS3Error(
            response,
            404,
            "NoSuchBucket",
            "The specified bucket does not exist.",
          );

          return;
        }

        response.setHeader(
          "x-amz-bucket-region",
          "us-east-1",
        );

        /*
         * Bucket-level operations.
         */

        if (
          segments.length ===
          1
        ) {
          if (
            request.method ===
            "HEAD"
          ) {
            response.writeHead(
              200,
            );

            response.end();

            return;
          }

          if (
            request.method ===
            "GET"
          ) {
            sendXml(
              response,
              200,
              listObjectsXml({
                bucket,
                objects,
              }),
            );

            return;
          }

          if (
            request.method ===
            "PUT"
          ) {
            response.writeHead(
              200,
            );

            response.end();

            return;
          }

          sendS3Error(
            response,
            405,
            "MethodNotAllowed",
            "Method not allowed.",
          );

          return;
        }

        const key =
          segments
            .slice(
              1,
            )
            .join(
              "/",
            );

        /*
         * PutObject.
         */

        if (
          request.method ===
          "PUT"
        ) {
          const body =
            await readRequestBody(
              request,
            );

          const metadata =
            Object.fromEntries(
              Object.entries(
                request.headers,
              )
                .filter(
                  ([
                    name,
                  ]) =>
                    name.startsWith(
                      "x-amz-meta-",
                    ),
                )
                .map(
                  ([
                    name,
                    value,
                  ]) => [
                    name,

                    Array.isArray(
                      value,
                    )
                      ? value.join(
                          ",",
                        )
                      : String(
                          value ??
                            "",
                        ),
                  ],
                ),
            );

          const etag =
            createHash(
              "sha256",
            )
              .update(
                body,
              )
              .digest(
                "hex",
              )
              .slice(
                0,
                32,
              );

          objects.set(
            key,
            {
              body,

              contentType:
                String(
                  request.headers[
                    "content-type"
                  ] ??
                    "application/octet-stream",
                ),

              metadata,

              etag,

              lastModified:
                new Date(),
            },
          );

          response.writeHead(
            200,
            {
              ETag:
                `"${etag}"`,
            },
          );

          response.end();

          return;
        }

        const object =
          objects.get(
            key,
          );

        /*
         * HeadObject.
         */

        if (
          request.method ===
          "HEAD"
        ) {
          if (
            !object
          ) {
            response.writeHead(
              404,
              {
                "x-amz-error-code":
                  "NoSuchKey",

                "x-amz-bucket-region":
                  "us-east-1",
              },
            );

            response.end();

            return;
          }

          writeObjectHeaders(
            response,
            object,
          );

          response.writeHead(
            200,
          );

          response.end();

          return;
        }

        /*
         * GetObject.
         */

        if (
          request.method ===
          "GET"
        ) {
          if (
            !object
          ) {
            sendS3Error(
              response,
              404,
              "NoSuchKey",
              "The specified key does not exist.",
            );

            return;
          }

          writeObjectHeaders(
            response,
            object,
          );

          response.writeHead(
            200,
          );

          response.end(
            object.body,
          );

          return;
        }

        /*
         * DeleteObject.
         */

        if (
          request.method ===
          "DELETE"
        ) {
          objects.delete(
            key,
          );

          response.writeHead(
            204,
          );

          response.end();

          return;
        }

        sendS3Error(
          response,
          405,
          "MethodNotAllowed",
          "Method not allowed.",
        );
      } catch (error) {
        sendS3Error(
          response,
          500,
          "InternalError",
          String(
            error?.message ??
              "Local S3 acceptance server failed.",
          ),
        );
      }
    },
  );
}

function writeObjectHeaders(
  response,
  object,
) {
  response.setHeader(
    "Content-Length",
    String(
      object.body
        .byteLength,
    ),
  );

  response.setHeader(
    "Content-Type",
    object.contentType,
  );

  response.setHeader(
    "ETag",
    `"${object.etag}"`,
  );

  response.setHeader(
    "Last-Modified",
    object.lastModified
      .toUTCString(),
  );

  for (
    const [
      name,
      value,
    ] of Object.entries(
      object.metadata,
    )
  ) {
    response.setHeader(
      name,
      value,
    );
  }
}

async function readRequestBody(
  request,
) {
  const chunks =
    [];

  let total =
    0;

  for await (
    const chunk of
      request
  ) {
    total +=
      chunk.length;

    if (
      total >
      32 * 1024 * 1024
    ) {
      throw new Error(
        "Local S3 acceptance object exceeded 32 MB.",
      );
    }

    chunks.push(
      chunk,
    );
  }

  return Buffer.concat(
    chunks,
  );
}

function listBucketsXml(
  bucket,
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',

    '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',

    "<Owner>",

    "<ID>biznoryx-local</ID>",

    "<DisplayName>BIZNORYX</DisplayName>",

    "</Owner>",

    "<Buckets>",

    "<Bucket>",

    `<Name>${xmlEscape(
      bucket,
    )}</Name>`,

    `<CreationDate>${new Date().toISOString()}</CreationDate>`,

    "</Bucket>",

    "</Buckets>",

    "</ListAllMyBucketsResult>",
  ].join(
    "",
  );
}

function listObjectsXml({
  bucket,
  objects,
}) {
  const contents =
    [
      ...objects.entries(),
    ]
      .map(
        ([
          key,
          object,
        ]) =>
          [
            "<Contents>",

            `<Key>${xmlEscape(
              key,
            )}</Key>`,

            `<LastModified>${object.lastModified.toISOString()}</LastModified>`,

            `<ETag>&quot;${object.etag}&quot;</ETag>`,

            `<Size>${object.body.byteLength}</Size>`,

            "<StorageClass>STANDARD</StorageClass>",

            "</Contents>",
          ].join(
            "",
          ),
      )
      .join(
        "",
      );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',

    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',

    `<Name>${xmlEscape(
      bucket,
    )}</Name>`,

    "<Prefix></Prefix>",

    `<KeyCount>${objects.size}</KeyCount>`,

    "<MaxKeys>1000</MaxKeys>",

    "<IsTruncated>false</IsTruncated>",

    contents,

    "</ListBucketResult>",
  ].join(
    "",
  );
}

function sendXml(
  response,
  status,
  body,
) {
  response.writeHead(
    status,
    {
      "Content-Type":
        "application/xml",

      "Content-Length":
        Buffer.byteLength(
          body,
        ),
    },
  );

  response.end(
    body,
  );
}

function sendS3Error(
  response,
  status,
  code,
  message,
) {
  const body =
    [
      '<?xml version="1.0" encoding="UTF-8"?>',

      "<Error>",

      `<Code>${xmlEscape(
        code,
      )}</Code>`,

      `<Message>${xmlEscape(
        message,
      )}</Message>`,

      "<RequestId>biznoryx-local</RequestId>",

      "</Error>",
    ].join(
      "",
    );

  response.writeHead(
    status,
    {
      "Content-Type":
        "application/xml",

      "Content-Length":
        Buffer.byteLength(
          body,
        ),
    },
  );

  response.end(
    body,
  );
}

function xmlEscape(
  value,
) {
  return String(
    value,
  )
    .replaceAll(
      "&",
      "&amp;",
    )
    .replaceAll(
      "<",
      "&lt;",
    )
    .replaceAll(
      ">",
      "&gt;",
    )
    .replaceAll(
      '"',
      "&quot;",
    )
    .replaceAll(
      "'",
      "&apos;",
    );
}

/*
 * ==================================================
 * DATABASE SETUP
 * ==================================================
 */

function applyMigrations(
  targetDatabase,
) {
  for (
    const file of
      sqlFiles(
        "db/migrations",
      ).filter(
        (
          name,
        ) =>
          !name.endsWith(
            ".down.sql",
          ),
      )
  ) {
    run(
      [
        ...admin,

        "-d",
        targetDatabase,

        "-v",
        "ON_ERROR_STOP=1",

        "-f",
        "-",
      ],
      {
        input:
          readFileSync(
            file,
          ),
      },
    );
  }
}

function applyBootstrap(
  targetDatabase,
  password,
) {
  for (
    const file of
      sqlFiles(
        "db/bootstrap",
      )
  ) {
    run(
      [
        ...admin,

        "-d",
        targetDatabase,

        "-v",
        "ON_ERROR_STOP=1",

        "-v",
        `biznoryx_app_password=${password}`,

        "-f",
        "-",
      ],
      {
        input:
          readFileSync(
            file,
          ),
      },
    );
  }
}

function sqlFiles(
  directory,
) {
  return readdirSync(
    directory,
  )
    .filter(
      (
        name,
      ) =>
        name.endsWith(
          ".sql",
        ),
    )
    .sort()
    .map(
      (
        name,
      ) =>
        join(
          directory,
          name,
        ),
    );
}

function run(
  args,
  {
    input,
    allowFailure = false,
  } = {},
) {
  const result =
    spawnSync(
      docker,
      args,
      {
        input,

        stdio:
          input
            ? [
                "pipe",
                "inherit",
                "inherit",
              ]
            : "inherit",
      },
    );

  if (
    !allowFailure &&
    result.status !==
      0
  ) {
    throw new Error(
      `Docker command failed with exit code ${result.status ?? 1}.`,
    );
  }
}

/*
 * ==================================================
 * ENVIRONMENT
 * ==================================================
 */

function readLocalEnvironmentValue(
  key,
) {
  const file =
    ".env.local";

  if (
    !existsSync(
      file,
    )
  ) {
    return null;
  }

  const contents =
    readFileSync(
      file,
      "utf8",
    );

  for (
    const rawLine of
      contents.split(
        /\r?\n/,
      )
  ) {
    const line =
      rawLine.trim();

    if (
      !line ||
      line.startsWith(
        "#",
      )
    ) {
      continue;
    }

    const separator =
      line.indexOf(
        "=",
      );

    if (
      separator <
      1
    ) {
      continue;
    }

    const currentKey =
      line
        .slice(
          0,
          separator,
        )
        .trim();

    if (
      currentKey !==
      key
    ) {
      continue;
    }

    let value =
      line
        .slice(
          separator +
            1,
        )
        .trim();

    if (
      value.length >=
        2 &&
      (
        (
          value.startsWith(
            '"',
          ) &&
          value.endsWith(
            '"',
          )
        ) ||
        (
          value.startsWith(
            "'",
          ) &&
          value.endsWith(
            "'",
          )
        )
      )
    ) {
      value =
        value.slice(
          1,
          -1,
        );
    }

    return value ||
      null;
  }

  return null;
}

/*
 * ==================================================
 * HTTP CLIENT
 * ==================================================
 */

function createApiClient(
  baseUrl,
  {
    cookie:
      initialCookie = null,
  } = {},
) {
  let cookie =
    initialCookie;

  let csrfToken =
    null;

  return {
    async call(
      pathname,
      {
        method =
          "GET",

        body,
      } = {},
    ) {
      const response =
        await fetch(
          `${baseUrl}${pathname}`,
          {
            method,

            headers: {
              Accept:
                "application/json",

              ...(
                body
                  ? {
                      "Content-Type":
                        "application/json",
                    }
                  : {}
              ),

              ...(
                cookie
                  ? {
                      Cookie:
                        cookie,
                    }
                  : {}
              ),

              ...(
                csrfToken &&
                method !==
                  "GET"
                  ? {
                      "X-CSRF-Token":
                        csrfToken,
                    }
                  : {}
              ),
            },

            body:
              body
                ? JSON.stringify(
                    body,
                  )
                : undefined,
          },
        );

      const nextCookie =
        response.headers
          .get(
            "set-cookie",
          );

      if (
        nextCookie
      ) {
        cookie =
          nextCookie
            .split(
              ";",
            )[0];
      }

      const text =
        await response.text();

      let responseBody;

      try {
        responseBody =
          text
            ? JSON.parse(
                text,
              )
            : {};
      } catch {
        responseBody = {
          raw:
            text,
        };
      }

      return {
        status:
          response.status,

        body:
          responseBody,
      };
    },

    setCsrfToken(
      value,
    ) {
      csrfToken =
        value;
    },

    getCookie() {
      return cookie;
    },
  };
}

/*
 * ==================================================
 * SERVER HELPERS
 * ==================================================
 */

async function listen(
  httpServer,
) {
  await new Promise(
    (
      resolve,
      reject,
    ) => {
      httpServer.once(
        "error",
        reject,
      );

      httpServer.listen(
        0,
        "127.0.0.1",
        () => {
          httpServer.off(
            "error",
            reject,
          );

          resolve();
        },
      );
    },
  );
}

async function closeServer(
  httpServer,
) {
  if (
    !httpServer?.listening
  ) {
    return;
  }

  await new Promise(
    (
      resolve,
      reject,
    ) => {
      httpServer.close(
        (
          error,
        ) => {
          if (
            error
          ) {
            reject(
              error,
            );

            return;
          }

          resolve();
        },
      );
    },
  );
}

function serverUrl(
  httpServer,
) {
  const address =
    httpServer.address();

  if (
    !address ||
    typeof address ===
      "string"
  ) {
    throw new Error(
      "Production application server address is unavailable.",
    );
  }

  return `http://127.0.0.1:${address.port}`;
}

function reportingMonth(
  value,
) {
  if (
    value instanceof
      Date &&
    !Number.isNaN(
      value.getTime(),
    )
  ) {
    return value
      .toISOString()
      .slice(
        0,
        7,
      );
  }

  const text =
    String(
      value ??
        "",
    );

  const match =
    /^(\d{4}-\d{2})/.exec(
      text,
    );

  return match
    ? match[1]
    : text;
}
