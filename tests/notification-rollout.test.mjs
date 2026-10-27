import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildNotificationRollout } from "../scripts/build-notification-rollout.mjs";

test("notification rollout preserves migration 0033 inside one bounded transaction", () => {
  const sql = buildNotificationRollout();
  const migration = readFileSync(
    "db/migrations/0033_in_app_updates.sql",
    "utf8",
  ).trim();
  assert.ok(sql.includes(migration.slice(6, -7)));
  assert.equal(sql.match(/^begin;$/gm).length, 1);
  assert.equal(sql.match(/^commit;$/gm).length, 1);
  assert.match(sql, /lock_timeout = '2s'/);
  assert.match(sql, /statement_timeout = '30s'/);
});

test("notification rollout adds no unrelated repairs, runtime roles or feature activation", () => {
  const sql = buildNotificationRollout();
  assert.doesNotMatch(
    sql,
    /billing_payments|runtime_pending_trial|alter\s+.+\s+owner\s+to|create\s+role|reassign\s+owned/i,
  );
  assert.doesNotMatch(
    sql,
    /insert\s+into\s+organization_features|update\s+organization_features\s+set/i,
  );
  assert.doesNotMatch(sql, /^\s*(drop|truncate|delete)\b/im);
  assert.match(sql, /values \('0033_in_app_updates.sql'\)/);
});

test("notification rollout refuses partial installs and binds only the operator-supplied existing role", () => {
  const sql = buildNotificationRollout();
  assert.match(sql, /:'notification_runtime_role'/);
  assert.match(sql, /already present or partial/);
  assert.match(sql, /Runtime must not inherit notification table ownership/);
  assert.match(sql, /Runtime must not enable features/);
  assert.match(sql, /grant update \(read_at, snoozed_until\)/);
  assert.match(sql, /to %I/);
});
