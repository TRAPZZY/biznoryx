import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { SourceFileDeletionService } from "../src/ingestion/source-file-deletion.mjs";
import { processSourceDeletionBatch } from "../src/worker/source-deletion-maintenance.mjs";
import { withTenantTransaction } from "../src/database/postgres.mjs";

const { Pool } = pg;

test("permanent source deletion preserves tenant and processing boundaries", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });

  const adminUrl = new URL(process.env.TEST_DATABASE_URL);
  adminUrl.username = "biznoryx_admin";
  adminUrl.password = process.env.TEST_ADMIN_PASSWORD ?? "";

  const admin = new Pool({
    connectionString: adminUrl.toString(),
  });

  const identity = new PostgresIdentityRepository(pool, {
    production: false,
  });

  const ingestion = new PostgresDataIngestionRepository(pool);

  const removedKeys = [];
  let storageFailure = false;


  const objectStorage = {
    async deleteObject({ key }) {
      if (storageFailure) {
        storageFailure = false;
        throw new Error("Simulated storage outage");
      }

      removedKeys.push(key);
      return { deleted: true };
    },
  };

  const deletion = new SourceFileDeletionService({
    pool,
    objectStorage,
  });

  try {
    const token = randomUUID().slice(0, 8);

    const owner = await identity.createUser({
      email: `deletion-owner-${token}@example.com`,
      displayName: "Deletion Test Owner",
      password: "SourceDeletionTest2026!",
    });

    const outsider = await identity.createUser({
      email: `deletion-outsider-${token}@example.com`,
      displayName: "Deletion Test Outsider",
      password: "SourceDeletionTest2026!",
    });

    const analyst = await identity.createUser({
      email: `deletion-analyst-${token}@example.com`,
      displayName: "Deletion Test Analyst",
      password: "SourceDeletionTest2026!",
    });

    const organization = await identity.createOrganization({
      actorUserId: owner.id,
      name: `Deletion Test ${token}`,
      slug: `deletion-test-${token}`,
    });

    const otherOrganization = await identity.createOrganization({
      actorUserId: outsider.id,
      name: `Outside Deletion ${token}`,
      slug: `outside-deletion-${token}`,
    });

    const tenant = {
      organizationId: organization.id,
      actorUserId: owner.id,
    };

    await withTenantTransaction(pool, tenant, async client => {
      await client.query(
        `insert into organization_memberships
           (id, organization_id, user_id, role)
         values ($1, $2, $3, 'analyst')`,
        [randomUUID(), organization.id, analyst.id],
      );
    });

    const source = await ingestion.ensureManualUploadSource(tenant);

    const stream = await ingestion.ensureStream({
      ...tenant,
      dataSourceId: source.id,
      name: `deletion-sales-${token}`,
      displayName: "Deletion test sales",
      grain: "monthly",
    });

    const standardColumns = [
      { name: "product", type: "text", required: true },
      { name: "revenue", type: "decimal", required: true },
    ];

    async function upload({
      month,
      content,
      columns = standardColumns,
    }) {
      const lastDay = new Date(
        Date.UTC(2026, Number(month), 0)
      ).getUTCDate();

      return ingestion.registerRawUpload({
        ...tenant,
        dataSourceId: source.id,
        dataStreamId: stream.id,
        upload: {
          originalFilename: `source-2026-${month}.csv`,
          contentType: "text/csv",
          content,
          byteSize: Buffer.byteLength(content),
          rowCount: 1,
          columns,
        },
        reportingPeriod: {
          periodStart: `2026-${month}-01`,
          periodEnd: `2026-${month}-${lastDay}`,
          label: `2026-${month}`,
        },
      });
    }

    // First upload establishes the accepted schema.
    const validated = await upload({
      month: "01",
      content: "product,revenue\nA,100\n",
    });

    assert.equal(validated.ingestionRun.status, "validated");

    // Changed required column creates a rejected upload.
    const rejected = await upload({
      month: "02",
      content: "item,revenue\nB,200\n",
      columns: [
        { name: "item", type: "text", required: true },
        { name: "revenue", type: "decimal", required: true },
      ],
    });

    assert.equal(rejected.ingestionRun.status, "rejected");

    // Another organization cannot delete this customer's file.
    await assert.rejects(
      deletion.delete({
        organizationId: otherOrganization.id,
        actorUserId: outsider.id,
        uploadId: rejected.ingestionRun.id,
      }),
      { code: "NOT_FOUND" },
    );

    // Analysts cannot perform irreversible deletion.
    await assert.rejects(
      deletion.delete({
        organizationId: organization.id,
        actorUserId: analyst.id,
        uploadId: rejected.ingestionRun.id,
      }),
      { code: "CAPABILITY_DENIED" },
    );

    // Simulate a rejection alert visible to the owner.
    // This previously caused legitimate deletion to be blocked.
    const notice = await admin.query(
      `select id from notification_events
       where organization_id = $1
         and ingestion_run_id = $2
         and kind = 'upload_attention'`,
      [organization.id, rejected.ingestionRun.id],
    );

    assert.equal(notice.rows.length, 1);

    await admin.query(
      `insert into notification_recipients
         (organization_id, event_id, user_id)
       values ($1, $2, $3)
       on conflict do nothing`,
      [organization.id, notice.rows[0].id, owner.id],
    );

    // Owner deletes the rejected file from PostgreSQL.
    const result = await deletion.delete({
      ...tenant,
      uploadId: rejected.ingestionRun.id,
    });

    assert.equal(result.deletedFromDatabase, true);

    // Related rejection notifications must cascade away.
    const remainingNotice = await admin.query(
      `select id from notification_events where id = $1`,
      [notice.rows[0].id],
    );

    const remainingRecipients = await admin.query(
      `select event_id from notification_recipients
       where event_id = $1`,
      [notice.rows[0].id],
    );

    assert.equal(remainingNotice.rows.length, 0);
    assert.equal(remainingRecipients.rows.length, 0);

    const remaining = await ingestion.listUploads(tenant);

    assert.equal(
      remaining.some(item => item.id === rejected.ingestionRun.id),
      false,
    );

    // Storage is deleted separately and its completion recorded.
    await processSourceDeletionBatch({ pool, objectStorage });

    const cleanup = await deletion.flushPending({
      ...tenant,
      onlyId: result.outboxId,
    });

    assert.ok(cleanup.completed.includes(result.outboxId));
    assert.ok(removedKeys.includes(rejected.rawObject.storageKey));

    const outbox = await withTenantTransaction(
      pool,
      tenant,
      async client => client.query(
        `select completed_at from source_file_deletion_outbox
         where organization_id = $1 and id = $2`,
        [organization.id, result.outboxId],
      ),
    );

    assert.ok(outbox.rows[0]?.completed_at);

    // Completed processing history protects a validated file.
    const protectedUpload = await upload({
      month: "03",
      content: "product,revenue\nC,300\n",
    });

    await admin.query(
      `update processing_jobs
       set status = 'succeeded'
       where organization_id = $1
         and ingestion_run_id = $2`,
      [organization.id, protectedUpload.ingestionRun.id],
    );

    await assert.rejects(
      deletion.delete({
        ...tenant,
        uploadId: protectedUpload.ingestionRun.id,
      }),
      { code: "CONFLICT" },
    );

    const protectedSource = await ingestion.getSourceFile({
      ...tenant,
      uploadId: protectedUpload.ingestionRun.id,
    });

    assert.equal(
      protectedSource.id,
      protectedUpload.rawObject.id,
    );

    // A temporary object-storage failure keeps a retry record.
    storageFailure = true;

    const validatedDelete = await deletion.delete({
      ...tenant,
      uploadId: validated.ingestionRun.id,
    });

    await processSourceDeletionBatch({ pool, objectStorage });

    const failedCleanup = await deletion.flushPending({
      ...tenant,
      onlyId: validatedDelete.outboxId,
    });

    assert.ok(
      failedCleanup.stillPending.includes(validatedDelete.outboxId),
    );

    await admin.query(
      `update source_file_deletion_outbox
       set available_at = now()
       where organization_id = $1 and id = $2`,
      [organization.id, validatedDelete.outboxId],
    );

    await processSourceDeletionBatch({ pool, objectStorage });

    const recoveredCleanup = await deletion.flushPending({
      ...tenant,
      onlyId: validatedDelete.outboxId,
    });

    assert.ok(
      recoveredCleanup.completed.includes(validatedDelete.outboxId),
    );

    assert.ok(
      removedKeys.includes(validated.rawObject.storageKey),
    );

    const protectedRemaining = await ingestion.listUploads(tenant);

    assert.equal(
      protectedRemaining.some(
        item => item.id === protectedUpload.ingestionRun.id
      ),
      true,
    );
  } finally {
    await Promise.all([pool.end(), admin.end()]);
  }
});