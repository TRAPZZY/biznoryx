import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  PostgresIdentityRepository,
} from "../src/database/identity-repository.mjs";

import {
  PostgresDataIngestionRepository,
} from "../src/database/data-ingestion-repository.mjs";

import {
  PostgresProcessingJobRepository,
} from "../src/database/processing-job-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL worker queue leases, completes, retries and reports healthy heartbeats",
  {
    skip:
      !connectionString,
  },
  async () => {
    const pool =
      new Pool({
        connectionString,
      });

    const identity =
      new PostgresIdentityRepository(
        pool,
        {
          production: false,
        },
      );

    const ingestion =
      new PostgresDataIngestionRepository(
        pool,
      );

    const jobs =
      new PostgresProcessingJobRepository(
        pool,
      );

    try {
      await pool.query(
        "delete from processing_jobs",
      );

      await pool.query(
        "delete from worker_heartbeats",
      );

      const nonce =
        `${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

      const owner =
        await identity.createUser({
          email:
            `worker-${nonce}@example.com`,

          displayName:
            "Worker Acceptance Owner",

          password:
            "StrongWorkerPass2026!",
        });

      const organization =
        await identity.createOrganization({
          actorUserId:
            owner.id,

          name:
            `Worker Test ${nonce}`,

          slug:
            `worker-${nonce}`
              .toLowerCase()
              .replace(
                /[^a-z0-9-]/g,
                "-",
              )
              .slice(
                0,
                48,
              ),
        });

      const source =
        await ingestion
          .ensureManualUploadSource({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,
          });

      const stream =
        await ingestion
          .ensureStream({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            dataSourceId:
              source.id,

            name:
              "worker-sales",

            displayName:
              "Worker sales",

            grain:
              "monthly",
          });

      const content =
        "product,revenue\nA,100.00\n";

      const first =
        await ingestion
          .registerRawUpload({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            dataSourceId:
              source.id,

            dataStreamId:
              stream.id,

            upload: {
              originalFilename:
                "worker-january.csv",

              contentType:
                "text/csv",

              content,

              byteSize:
                Buffer.byteLength(
                  content,
                ),

              rowCount:
                1,

              columns: [
                {
                  name:
                    "product",

                  type:
                    "text",

                  required:
                    true,
                },

                {
                  name:
                    "revenue",

                  type:
                    "decimal",

                  required:
                    true,
                },
              ],
            },

            reportingPeriod: {
              periodStart:
                "2026-01-01",

              periodEnd:
                "2026-01-31",

              label:
                "January 2026",
            },
          });

      assert.equal(
        first.ingestionRun.status,
        "validated",
      );

      const healthBefore =
        await jobs.queueHealth();

      assert.equal(
        healthBefore.queued,
        1,
      );

      await jobs.heartbeat({
        workerId:
          "acceptance-worker",

        status:
          "ready",

        metadata: {
          test:
            true,
        },
      });

      assert.equal(
        await jobs.hasHealthyWorker({
          maxAgeSeconds:
            30,
        }),
        true,
      );

      const leased =
        await jobs.leaseNext({
          workerId:
            "acceptance-worker",

          leaseSeconds:
            60,
        });

      assert.ok(
        leased,
      );

      assert.equal(
        leased.organizationId,
        organization.id,
      );

      assert.equal(
        leased.ingestionRunId,
        first.ingestionRun.id,
      );

      assert.equal(
        leased.jobType,
        "ingestion.verify_storage",
      );

      assert.equal(
        leased.status,
        "leased",
      );

      assert.equal(
        leased.attempts,
        1,
      );

      const context =
        await jobs.getIngestionContext({
          job:
            leased,
        });

      assert.equal(
        context.organizationId,
        organization.id,
      );

      assert.equal(
        context.ingestionRunId,
        first.ingestionRun.id,
      );

      assert.equal(
        context.rawObject.id,
        first.rawObject.id,
      );

      assert.equal(
        context.rawObject.checksumSha256,
        first.rawObject.checksumSha256,
      );

      const completed =
        await jobs.complete({
          jobId:
            leased.id,

          workerId:
            "acceptance-worker",
        });

      assert.equal(
        completed.status,
        "succeeded",
      );

      assert.ok(
        completed.completedAt,
      );

      const secondContent =
        "product,revenue\nB,250.00\n";

      const second =
        await ingestion
          .registerRawUpload({
            organizationId:
              organization.id,

            actorUserId:
              owner.id,

            dataSourceId:
              source.id,

            dataStreamId:
              stream.id,

            upload: {
              originalFilename:
                "worker-february.csv",

              contentType:
                "text/csv",

              content:
                secondContent,

              byteSize:
                Buffer.byteLength(
                  secondContent,
                ),

              rowCount:
                1,

              columns: [
                {
                  name:
                    "product",

                  type:
                    "text",

                  required:
                    true,
                },

                {
                  name:
                    "revenue",

                  type:
                    "decimal",

                  required:
                    true,
                },
              ],
            },

            reportingPeriod: {
              periodStart:
                "2026-02-01",

              periodEnd:
                "2026-02-28",

              label:
                "February 2026",
            },
          });

      const secondLease =
        await jobs.leaseNext({
          workerId:
            "acceptance-worker",

          leaseSeconds:
            60,
        });

      assert.equal(
        secondLease.ingestionRunId,
        second.ingestionRun.id,
      );

      const failed =
        await jobs.fail({
          jobId:
            secondLease.id,

          workerId:
            "acceptance-worker",

          error:
            new Error(
              "Intentional acceptance failure",
            ),
        });

      assert.equal(
        failed.status,
        "failed",
      );

      assert.equal(
        failed.attempts,
        1,
      );

      assert.match(
        failed.lastError,
        /Intentional acceptance failure/,
      );

      const finalHealth =
        await jobs.queueHealth();

      assert.equal(
        finalHealth.leased,
        0,
      );

      assert.equal(
        finalHealth.failed,
        1,
      );
    } finally {
      await pool.end();
    }
  },
);