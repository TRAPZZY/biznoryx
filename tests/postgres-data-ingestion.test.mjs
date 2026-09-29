import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  PostgresIdentityRepository,
} from "../src/database/identity-repository.mjs";

import {
  PostgresDataIngestionRepository,
} from "../src/database/data-ingestion-repository.mjs";

const {
  Pool,
} = pg;

const connectionString =
  process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL ingestion persists tenant-scoped recurring uploads",
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

    try {
      /*
       * Create the first tenant.
       */
      const owner =
        await identity.createUser({
          email:
            `ingestion-owner-${Date.now()}@example.com`,

          displayName:
            "Ingestion Owner",

          password:
            "StrongIngestionPass2026!",
        });

      const organization =
        await identity.createOrganization({
          actorUserId:
            owner.id,

          name:
            `Ingestion Test ${Date.now()}`,

          slug:
            `ingestion-test-${Date.now()}`,
        });

      const source =
        await ingestion.ensureManualUploadSource({
          organizationId:
            organization.id,

          actorUserId:
            owner.id,
        });

      assert.equal(
        source.organizationId,
        organization.id,
      );

      assert.equal(
        source.sourceType,
        "manual_upload",
      );

      const stream =
        await ingestion.ensureStream({
          organizationId:
            organization.id,

          actorUserId:
            owner.id,

          dataSourceId:
            source.id,

          name:
            "monthly-sales",

          displayName:
            "Monthly sales",

          grain:
            "monthly",
        });

      assert.equal(
        stream.organizationId,
        organization.id,
      );

      /*
       * First period establishes the schema.
       */
      const first =
        await ingestion.registerRawUpload({
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
              "sales-2026-01.csv",

            contentType:
              "text/csv",

            content:
              "product,revenue\nA,100.00\nB,200.00\n",

            byteSize:
              Buffer.byteLength(
                "product,revenue\nA,100.00\nB,200.00\n",
              ),

            rowCount: 2,

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

      assert.equal(
        first.ingestionRun.schemaDrift,
        "none",
      );

      assert.equal(
        first.rawObject.status,
        "accepted",
      );

      assert.ok(
        first.rawObject
          .checksumSha256,
      );

      assert.ok(
        first.schemaVersion,
      );

      /*
       * Second period uses the same recurring
       * stream and active schema.
       */
      const second =
        await ingestion.registerRawUpload({
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
              "sales-2026-02.csv",

            contentType:
              "text/csv",

            content:
              "product,revenue\nA,150.00\nC,250.00\n",

            byteSize:
              Buffer.byteLength(
                "product,revenue\nA,150.00\nC,250.00\n",
              ),

            rowCount: 2,

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

      assert.equal(
        second.ingestionRun.status,
        "validated",
      );

      assert.equal(
        second.ingestionRun.schemaDrift,
        "none",
      );

      /*
       * Data survives a new repository
       * instance.
       */
      const restartedRepository =
        new PostgresDataIngestionRepository(
          pool,
        );

      const uploads =
        await restartedRepository.listUploads({
          organizationId:
            organization.id,

          actorUserId:
            owner.id,
        });

      assert.equal(
        uploads.length,
        2,
      );

      assert.deepEqual(
        uploads.map(
          (entry) =>
            entry.reportingPeriod
              .label,
        ),
        [
          "February 2026",
          "January 2026",
        ],
      );

      /*
       * Duplicate immutable raw content
       * must be rejected.
       */
      await assert.rejects(
        ingestion.registerRawUpload({
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
              "duplicate.csv",

            contentType:
              "text/csv",

            content:
              "product,revenue\nA,150.00\nC,250.00\n",

            byteSize:
              Buffer.byteLength(
                "product,revenue\nA,150.00\nC,250.00\n",
              ),

            rowCount: 2,

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
              "2026-03-01",

            periodEnd:
              "2026-03-31",

            label:
              "March 2026",
          },
        }),

        (error) =>
          error?.code ===
          "VALIDATION_FAILED",
      );

      /*
       * Create second tenant and prove
       * cross-tenant access is denied.
       */
      const outsider =
        await identity.createUser({
          email:
            `ingestion-outsider-${Date.now()}@example.com`,

          displayName:
            "Outside User",

          password:
            "StrongOutsidePass2026!",
        });

      const outsiderOrganization =
        await identity.createOrganization({
          actorUserId:
            outsider.id,

          name:
            `Outside Test ${Date.now()}`,

          slug:
            `outside-test-${Date.now()}`,
        });

      assert.ok(
        outsiderOrganization.id,
      );

      await assert.rejects(
        ingestion.listUploads({
          organizationId:
            organization.id,

          actorUserId:
            outsider.id,
        }),

        (error) =>
          error?.code ===
          "ORG_ACCESS_DENIED",
      );
    } finally {
      await pool.end();
    }
  },
);