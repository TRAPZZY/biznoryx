import assert from "node:assert/strict";
import test from "node:test";

import {
  SourceFileDeletionService,
} from "../src/ingestion/source-file-deletion.mjs";

import {
  processSourceDeletionBatch,
} from "../src/worker/source-deletion-maintenance.mjs";

test("deletion status inspection never calls R2 delete", async () => {
  let deletes = 0;

  const client = {
    async query(sql) {
      const statement = String(sql);

      if (statement.includes("from organization_memberships")) {
        return { rows: [{ role: "owner" }] };
      }

      if (statement.includes("from source_file_deletion_outbox")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000041",
            status: "pending",
            completed_at: null,
          }],
        };
      }

      return { rows: [] };
    },
    release() {},
  };

  const service = new SourceFileDeletionService({
    pool: { async connect() { return client; } },
    objectStorage: {
      async deleteObject() {
        deletes++;
      },
    },
  });

  const result = await service.flushPending({
    organizationId: "org-a",
    actorUserId: "user-a",
  });

  assert.equal(deletes, 0);
  assert.equal(result.stillPending.length, 1);
});

test("leased worker is the R2 deletion executor", async () => {
  const deleted = [];

  const pool = {
    async query(sql) {
      const statement = String(sql);

      if (statement.includes("to_regprocedure")) {
        return { rows: [{ ready: "claim_source_file_deletions" }] };
      }

      if (statement.includes("from claim_source_file_deletions")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000041",
            organization_id: "org-a",
            storage_key: "organizations/org-a/uploads/hash/source.csv",
            lease_token: "00000000-0000-4000-8000-000000000042",
            attempts: 1,
          }],
        };
      }

      if (statement.includes("finish_source_file_deletion")) {
        return { rows: [{ acknowledged: true }] };
      }

      throw new Error("Unexpected database query");
    },
  };

  const completed = await processSourceDeletionBatch({
    pool,
    objectStorage: {
      async deleteObject({ key }) {
        deleted.push(key);
        return { deleted: true };
      },
    },
  });

  assert.equal(completed, 1);
  assert.equal(deleted.length, 1);
});
