import assert from "node:assert/strict";
import test from "node:test";

import { PostgresActivityRepository } from "../src/database/activity-repository.mjs";

function createFakePool(auditRows) {
  const calls = [];

  let released = false;

  const client = {
    async query(sql, params = []) {
      calls.push({
        sql,
        params,
      });

      if (String(sql).includes("from audit_events")) {
        return {
          rows: auditRows,
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

test("production activity repository reads tenant audit history", async () => {
  const organizationId = "11111111-1111-1111-1111-111111111111";

  const actorUserId = "22222222-2222-2222-2222-222222222222";

  const createdAt = new Date("2026-09-30T12:00:00.000Z");

  const pool = createFakePool([
    {
      id: "33333333-3333-3333-3333-333333333333",

      organization_id: organizationId,

      actor_user_id: actorUserId,

      event_type: "business_profile.updated",

      target_type: "business_profile",

      target_id: "44444444-4444-4444-4444-444444444444",

      metadata: {},

      created_at: createdAt,
    },
  ]);

  const repository = new PostgresActivityRepository(pool);

  const activity = await repository.listActivity({
    organizationId,
    actorUserId,
  });

  assert.equal(activity.length, 1);

  assert.equal(activity[0].label, "Business profile updated");

  assert.equal(activity[0].detail, "Business profile");

  assert.equal(activity[0].eventType, "business_profile.updated");

  assert.equal(activity[0].createdAt, createdAt);

  assert.equal(pool.released, true);

  assert.ok(
    pool.calls.some(
      ({ sql, params }) =>
        String(sql).includes("app.current_organization_id") &&
        params[0] === organizationId,
    ),
  );

  assert.ok(
    pool.calls.some(
      ({ sql, params }) =>
        String(sql).includes("app.current_user_id") &&
        params[0] === actorUserId,
    ),
  );

  const selectCall = pool.calls.find(({ sql }) =>
    String(sql).includes("from audit_events"),
  );

  assert.ok(selectCall);

  assert.deepEqual(selectCall.params, [organizationId, 100]);
});

test("production activity repository limits oversized activity requests", async () => {
  const pool = createFakePool([]);

  const repository = new PostgresActivityRepository(pool);

  await repository.listActivity({
    organizationId: "11111111-1111-1111-1111-111111111111",

    actorUserId: "22222222-2222-2222-2222-222222222222",

    limit: 10000,
  });

  const selectCall = pool.calls.find(({ sql }) =>
    String(sql).includes("from audit_events"),
  );

  assert.ok(selectCall);

  assert.equal(selectCall.params[1], 200);
});
