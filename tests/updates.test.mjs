import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";
import { updateOptions, updateState, preferenceInput, updateItem } from "../src/notifications/updates.mjs";
import { PostgresUpdatesRepository } from "../src/database/updates-repository.mjs";
import { deliverUpdates } from "../src/worker/updates-maintenance.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(43);

test("Updates validates bounded filters, recipient state and preferences", () => {
  assert.deepEqual(updateOptions({ limit: "5" }), { limit: 5, offset: 0, filter: "all", category: "all" });
  for (const input of [{ limit: 500 }, { offset: -1 }, { filter: "sql" }, { category: "billing" }, { limit: "NaN" }]) assert.throws(() => updateOptions(input), AuthError);
  assert.deepEqual(updateState({ id, action: "snooze", hours: 24 }, new Date("2026-10-20T09:00Z")), { id, action: "snooze", until: new Date("2026-10-21T09:00Z") });
  for (const input of [{ id, action: "resolve" }, { id, action: "snooze", hours: 999 }, { id: "../../secret", action: "read" }]) assert.throws(() => updateState(input), AuthError);
  assert.throws(() => preferenceInput({ category: "reports", enabled: "false" }), AuthError);
  assert.throws(() => preferenceInput({ category: "push", enabled: true }), AuthError);
});

test("Updates presents source evidence without unsupported money or causal claims", () => {
  const item = updateItem({ id, kind: "upload_attention", ingestion_run_id: id, evidence_status: "superseded", period_label: "October" });
  assert.equal(item.evidenceStatus, "superseded");
  assert.equal(item.href, `#/data?upload=${id}`);
  assert.equal(item.title, "A file needs your review");
});

test("unmigrated Updates runtime does not query absent notification tables", async () => {
  const queries = [];
  const pool = { async connect() { return { async query(sql) {
    queries.push(sql);
    if (sql.includes("from organization_memberships")) return { rows: [{ role: "viewer" }] };
    if (sql.includes("to_regclass")) return { rows: [{ feature_table: null }] };
    return { rows: [] };
  }, release() {} }; } };
  const repository = new PostgresUpdatesRepository(pool);
  assert.deepEqual(await repository.list({ organizationId: "org-a", actorUserId: "user-a" }), { enabled: false, items: [], unreadCount: 0 });
  assert.equal(queries.some(sql => sql.includes("from notification_")), false);
});

test("worker schema probe is safe before migration and does not hide query errors", async () => {
  assert.equal(await deliverUpdates({ async query() { return { rows: [{ delivery_function: null }] }; } }), 0);
  await assert.rejects(deliverUpdates({ async query() { throw new Error("offline"); } }), /offline/);
});

test("production Updates routes derive tenant/recipient, preserve CSRF and native bearer", async () => {
  const calls = [];
  const repository = Object.fromEntries(["list", "setState", "markAllRead", "setPreference"].map(name => [name, async input => {
    calls.push({ name, input });
    return name === "list" ? { enabled: true, unreadCount: 0, items: [] } : { saved: true };
  }]));
  const { server } = createProductionApp({
    identityRepository: { async authenticate({ token: supplied, csrfToken, requireCsrf }) {
      if (supplied !== token) throw new AuthError("Session expired.", "SESSION_INVALID");
      if (requireCsrf && csrfToken !== "csrf") throw new AuthError("Invalid CSRF token.", "CSRF_INVALID");
      return { user: { id: "user-a" }, session: { activeOrganizationId: "org-a" } };
    } }, emailVerificationRepository: {}, updatesRepository: repository, production: false,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = { cookie: `bnx_session=${token}` }) => fetch(`${base}/api/updates${path}`, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("", undefined, {})).status, 401);
    assert.equal((await request("?limit=5&organizationId=foreign&actorUserId=other")).status, 200);
    assert.equal(calls.at(-1).input.organizationId, "org-a");
    assert.equal(calls.at(-1).input.actorUserId, "user-a");
    assert.equal((await request("/state", { id, action: "read" })).status, 403);
    assert.equal((await request("/state", { id, action: "read", organizationId: "foreign" }, { cookie: `bnx_session=${token}`, "x-csrf-token": "csrf" })).status, 200);
    assert.equal(calls.at(-1).input.organizationId, "org-a");
    assert.equal((await request("/state", { id, action: "unread" }, { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await request("?limit=500")).status, 400);
    assert.equal((await request("/read-all", { through: "2099-01-01" }, { cookie: `bnx_session=${token}`, "x-csrf-token": "csrf" })).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
