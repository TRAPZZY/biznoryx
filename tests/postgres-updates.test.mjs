import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresDataIngestionRepository } from "../src/database/data-ingestion-repository.mjs";
import { PostgresVerifiedMetricsRepository } from "../src/database/verified-metrics-repository.mjs";
import { PostgresUpdatesRepository } from "../src/database/updates-repository.mjs";
import { withTenantTransaction } from "../src/database/postgres.mjs";
import { deliverUpdates } from "../src/worker/updates-maintenance.mjs";

const connectionString = process.env.UPDATES_TEST_ADMIN_DATABASE_URL;

test("PostgreSQL Updates outbox, delivery, recipient state and tenant boundaries", { skip: !connectionString }, async t => {
  const admin = new pg.Pool({ connectionString });
  const runtime = new pg.Pool({ connectionString, options: "-c role=biznoryx_app" });
  const identity = new PostgresIdentityRepository(admin, { production: false });
  const ingestion = new PostgresDataIngestionRepository(runtime);
  const metrics = new PostgresVerifiedMetricsRepository(runtime);
  const updates = new PostgresUpdatesRepository(runtime);
  const nonce = randomUUID();
  const user = label => identity.createUser({ email: `updates-${label}-${nonce}@example.com`, displayName: `Updates ${label}`, password: "UpdatesTestPassword2026!" });
  const owner = await user("owner"), viewer = await user("viewer"), outsider = await user("outsider"), revoked = await user("revoked");
  const org = await identity.createOrganization({ actorUserId: owner.id, name: `Updates ${nonce}`, slug: `updates-${nonce}` });
  const foreign = await identity.createOrganization({ actorUserId: outsider.id, name: `Other ${nonce}`, slug: `other-${nonce}` });
  const scope = { organizationId: org.id, actorUserId: owner.id };
  const viewerScope = { ...scope, actorUserId: viewer.id };
  await admin.query("insert into organization_memberships(organization_id,user_id,role,status) values ($1,$2,'viewer','active')", [org.id, viewer.id]);
  await admin.query("insert into organization_memberships(organization_id,user_id,role,status) values ($1,$2,'analyst','active')", [org.id, revoked.id]);
  const flag = enabled => admin.query(`insert into organization_features(organization_id,feature_key,enabled) values ($1,'in_app_updates',$2)
    on conflict (organization_id,feature_key) do update set enabled = excluded.enabled`, [org.id, enabled]);
  let stream;
  async function upload(content = "product,revenue\nA,120.00\n") {
    const source = await ingestion.ensureManualUploadSource(scope);
    stream ??= await ingestion.ensureStream({ ...scope, dataSourceId: source.id, name: "updates-sales", displayName: "Sales", grain: "monthly" });
    return ingestion.registerRawUpload({ ...scope, dataSourceId: source.id, dataStreamId: stream.id,
      upload: { originalFilename: "sales.csv", contentType: "text/csv", content, byteSize: Buffer.byteLength(content), rowCount: 1,
        columns: [{ name: "product", type: "text", required: true }, { name: "revenue", type: "decimal", required: true }] },
      reportingPeriod: { periodStart: "2026-10-01", periodEnd: "2026-10-31", label: "October 2026" } });
  }
  async function ready(result) {
    await metrics.replaceIngestionMetrics({ organizationId: org.id, ingestionRunId: result.ingestionRun.id, metrics: [
      { metricKey: "sum:revenue", label: "Revenue", sourceColumn: "revenue", aggregation: "sum", value: "120.00", contributingRowCount: 1, sourceRowCount: 1, evidence: {} },
    ] });
    await admin.query("update processing_jobs set status='succeeded' where organization_id=$1 and ingestion_run_id=$2", [org.id, result.ingestionRun.id]);
  }
  try {
    await t.test("restricted runtime and default disabled behavior", async () => {
      const role = await runtime.query("select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user");
      assert.equal(role.rows[0].current_user, "biznoryx_app");
      assert.equal(role.rows[0].rolsuper, false);
      assert.equal(role.rows[0].rolbypassrls, false);
      assert.equal((await updates.list(scope)).enabled, false);
      await assert.rejects(updates.setPreference({ ...scope, preference: { category: "data", enabled: false } }), e => e.code === "SERVICE_UNAVAILABLE");
      await flag(true);
    });
    const first = await upload();
    await t.test("no event for unprocessed uploads; source and event roll back together", async () => {
      assert.equal((await updates.list(scope)).items.length, 0);
      const client = await admin.connect();
      try {
        await client.query("begin");
        await client.query("update ingestion_runs set status='rejected' where id=$1", [first.ingestionRun.id]);
        assert.equal((await client.query("select count(*)::integer as n from notification_events where organization_id=$1", [org.id])).rows[0].n, 1);
        await client.query("rollback");
      } finally { client.release(); }
      assert.equal((await admin.query("select count(*)::integer as n from notification_events where organization_id=$1", [org.id])).rows[0].n, 0);
    });
    await ready(first);
    await admin.query("update organization_memberships set status='disabled' where organization_id=$1 and user_id=$2", [org.id, revoked.id]);
    await t.test("concurrent workers and replay produce one inbox item per recipient", async () => {
      await Promise.all([deliverUpdates(runtime), deliverUpdates(runtime)]);
      await deliverUpdates(runtime);
      assert.equal((await updates.list(scope)).items.length, 1);
      assert.equal((await updates.list(viewerScope)).items.length, 1);
      assert.equal((await admin.query("select count(*)::integer as n from notification_recipients where organization_id=$1 and user_id=$2", [org.id, revoked.id])).rows[0].n, 0);
      await ready(first);
      await deliverUpdates(runtime);
      assert.equal((await updates.list(scope)).items.length, 1);
    });
    const item = (await updates.list(scope)).items[0];
    await t.test("per-user read, snooze and mark-all-read state is independent", async () => {
      await updates.setState({ ...scope, change: { id: item.id, action: "read" } });
      assert.equal((await updates.list(scope)).unreadCount, 0);
      assert.equal((await updates.list(viewerScope)).unreadCount, 1);
      await updates.setState({ ...scope, change: { id: item.id, action: "unread" } });
      await updates.setState({ ...scope, change: { id: item.id, action: "snooze", until: new Date(Date.now() + 3600000) } });
      assert.equal((await updates.list({ ...scope, filter: "snoozed" })).items.length, 1);
      assert.equal((await updates.list(scope)).unreadCount, 0);
      await updates.setState({ ...scope, change: { id: item.id, action: "snooze", until: null } });
      await updates.markAllRead({ ...scope, through: new Date("2000-01-01") });
      assert.equal((await updates.list(scope)).unreadCount, 1);
      await updates.markAllRead({ ...scope, through: new Date() });
      assert.equal((await updates.list(scope)).unreadCount, 0);
    });
    await t.test("preferences and changed access are checked at delivery and read time", async () => {
      await updates.setPreference({ ...viewerScope, preference: { category: "reports", enabled: false } });
      await admin.query("update organization_memberships set status='disabled' where organization_id=$1 and user_id=$2", [org.id, viewer.id]);
      await assert.rejects(updates.list(viewerScope), e => e.code === "ORG_ACCESS_DENIED");
      await admin.query("update organization_memberships set status='active' where organization_id=$1 and user_id=$2", [org.id, viewer.id]);
      const next = await upload("product,revenue\nB,120.00\n");
      await ready(next);
      await deliverUpdates(runtime);
      const ownerItems = (await updates.list(scope)).items;
      assert.equal(ownerItems.length, 2);
      assert.equal(ownerItems.find(x => x.id === item.id).evidenceStatus, "superseded");
      assert.equal((await updates.list(viewerScope)).items.length, 1);
    });
    await t.test("foreign IDs and raw RLS queries cannot cross tenant or recipient boundaries", async () => {
      const otherScope = { organizationId: foreign.id, actorUserId: outsider.id };
      await flag(false);
      await assert.rejects(updates.setState({ ...scope, change: { id: item.id, action: "read" } }), e => e.code === "SERVICE_UNAVAILABLE");
      await flag(true);
      await assert.rejects(updates.setState({ ...viewerScope, organizationId: foreign.id, change: { id: item.id, action: "read" } }), e => e.code === "ORG_ACCESS_DENIED");
      const rows = await withTenantTransaction(runtime, otherScope, client => client.query("select id from notification_events"));
      assert.equal(rows.rows.length, 0);
      await assert.rejects(withTenantTransaction(runtime, viewerScope, client => client.query("update notification_recipients set user_id=$1", [owner.id])), /permission denied/);
      await assert.rejects(runtime.query("insert into organization_features(organization_id, feature_key, enabled) values ($1,'in_app_updates',true)", [foreign.id]), /permission denied/);
      await assert.rejects(admin.query("insert into notification_events(organization_id, ingestion_run_id, kind, source_revision) values ($1,$2,'report_ready','invalid')", [foreign.id, first.ingestionRun.id]), /foreign key/);
    });
    await t.test("delivery rollback, retry exhaustion and operator recovery retain evidence", async () => {
      const next = await upload("product,revenue\nC,120.00\n");
      await ready(next);
      const event = (await admin.query("select id from notification_events where ingestion_run_id=$1 and kind='report_ready'", [next.ingestionRun.id])).rows[0];
      const client = await admin.connect();
      try {
        await client.query("begin");
        await client.query("select deliver_source_updates(100)");
        assert.equal((await client.query("select count(*)::integer as n from notification_recipients where event_id=$1", [event.id])).rows[0].n, 1);
        await client.query("rollback");
      } finally { client.release(); }
      assert.equal((await admin.query("select count(*)::integer as n from notification_recipients where event_id=$1", [event.id])).rows[0].n, 0);
      const suffix = randomUUID().replaceAll("-", "");
      const name = `test_updates_failure_${suffix}`;
      await admin.query(`create function ${name}() returns trigger language plpgsql as $$ begin
        if new.event_id = '${event.id}'::uuid then raise exception 'Synthetic delivery failure'; end if; return new; end $$`);
      await admin.query(`create trigger ${name} before insert on notification_recipients for each row execute function ${name}()`);
      try {
        for (let attempt = 1; attempt <= 5; attempt++) {
          await admin.query("update notification_events set available_at=now() where id=$1", [event.id]);
          await deliverUpdates(runtime);
          const state = (await admin.query("select status,attempts,last_error_code from notification_events where id=$1", [event.id])).rows[0];
          assert.equal(state.attempts, attempt);
          assert.equal(state.status, attempt === 5 ? "dead" : "pending");
          assert.equal(state.last_error_code, "DELIVERY_FAILED");
        }
      } finally {
        await admin.query(`drop trigger ${name} on notification_recipients`);
        await admin.query(`drop function ${name}()`);
      }
      assert.equal((await admin.query("select count(*)::integer as n from notification_recipients where event_id=$1", [event.id])).rows[0].n, 0);
      await admin.query("update notification_events set status='pending',attempts=0,available_at=now() where id=$1", [event.id]);
      await deliverUpdates(runtime);
      assert.equal((await admin.query("select count(*)::integer as n from notification_recipients where event_id=$1", [event.id])).rows[0].n, 1);
    });
  } finally { await runtime.end(); await admin.end(); }
});
