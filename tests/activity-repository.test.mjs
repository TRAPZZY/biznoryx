import assert from "node:assert/strict";
import test from "node:test";

import { PostgresActivityRepository } from "../src/database/activity-repository.mjs";

function createFakePool(rows) {
  const calls = [];

  let released = false;

  const client = {
    async query(sql, params = []) {
      calls.push({
        sql: String(sql),

        params,
      });

      if (String(sql).includes("from audit_events")) {
        return {
          rows,
          rowCount: rows.length,
        };
      }

      return {
        rows: [],
        rowCount: 0,
      };
    },

    release() {
      released = true;
    },
  };

  return {
    calls,

    get released() {
      return released;
    },

    async connect() {
      return client;
    },
  };
}

test("Activity reads tenant-scoped audit history", async () => {
  const organizationId = "11111111-1111-1111-1111-111111111111";

  const actorUserId = "22222222-2222-2222-2222-222222222222";

  const pool = createFakePool([
    {
      id: "33333333-3333-3333-3333-333333333333",

      organization_id: organizationId,

      actor_user_id: actorUserId,

      event_type: "ingestion_run.validated",

      target_type: "ingestion_run",

      target_id: "44444444-4444-4444-4444-444444444444",

      metadata: {
        fileName: "sales.csv",

        rowCount: 315,
      },

      created_at: new Date("2026-09-30T20:00:00.000Z"),
    },
  ]);

  const repository = new PostgresActivityRepository(pool);

  const events = await repository.listActivity({
    organizationId,
    actorUserId,
  });

  assert.equal(events.length, 1);

  assert.equal(events[0].label, "Upload validated");

  assert.equal(events[0].detail, "Business data upload · sales.csv · 315 rows");

  const activityQuery = pool.calls.find(({ sql }) =>
    sql.includes("from audit_events"),
  );

  assert.ok(activityQuery);

  assert.deepEqual(activityQuery.params, [organizationId, 100]);

  assert.ok(
    pool.calls.some(
      ({ sql, params }) =>
        sql.includes("app.current_organization_id") &&
        params[0] === organizationId,
    ),
  );

  assert.ok(
    pool.calls.some(
      ({ sql, params }) =>
        sql.includes("app.current_user_id") && params[0] === actorUserId,
    ),
  );

  assert.equal(pool.released, true);
});
