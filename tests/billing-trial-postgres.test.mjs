import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { PostgresBillingRepository, withBillingTenant } from "../src/database/billing-repository.mjs";
import { subscriptionHasPremiumAccess } from "../src/billing/entitlements.mjs";

const adminUrl = process.env.TRIAL_TEST_ADMIN_DATABASE_URL;

test("isolated PostgreSQL trial migration, fresh bootstrap, RLS, constraints and runtime recovery grants", { skip: !adminUrl }, async () => {
  const url = new URL(adminUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Only a local isolated acceptance database is allowed");
  assert.equal(url.pathname, "/postgres");
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `bnx_trial_test_${suffix}`;
  const runtimeRole = `bnx_trial_role_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminUrl });
  let ownerPool;
  let runtime;
  let databaseCreated = false;
  let roleCreated = false;
  try {
    await admin.query(`create database ${databaseName}`);
    databaseCreated = true;
    url.pathname = `/${databaseName}`;
    ownerPool = new pg.Pool({ connectionString: url.href });
    for (const file of (await readdir("db/migrations")).filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql")).sort()) {
      // The temporary role is intentionally absent during every migration.
      const sql = (await readFile(`db/migrations/${file}`, "utf8")).replaceAll("biznoryx_app", runtimeRole);
      await ownerPool.query(sql);
    }
    await admin.query(`create role ${runtimeRole} login password 'synthetic-local-test-only' nobypassrls`);
    roleCreated = true;
    const baseBootstrap = await readFile("db/bootstrap/001_runtime_role.sql", "utf8");
    await ownerPool.query(baseBootstrap.slice(baseBootstrap.indexOf("grant usage")).replaceAll("biznoryx_app", runtimeRole));
    await ownerPool.query((await readFile("db/bootstrap/011_trial_billing_grants.sql", "utf8")).replaceAll("biznoryx_app", runtimeRole));
    url.username = runtimeRole;
    url.password = "synthetic-local-test-only";
    runtime = new pg.Pool({ connectionString: url.href, max: 1 });
    const ownerId = randomUUID(); const viewerId = randomUUID(); const orgA = randomUUID(); const orgB = randomUUID();
    await ownerPool.query(`insert into app_users (id,email,display_name,password_hash) values
      ($1,'owner@test.invalid','Owner','synthetic'), ($2,'viewer@test.invalid','Viewer','synthetic')`, [ownerId, viewerId]);
    await ownerPool.query(`insert into organizations (id,name,slug,created_by_user_id) values
      ($1,'A','trial-a',$3),($2,'B','trial-b',$3)`, [orgA, orgB, ownerId]);
    await ownerPool.query(`insert into organization_memberships (organization_id,user_id,role) values
      ($1,$2,'owner'),($1,$3,'viewer')`, [orgA, ownerId, viewerId]);
    const billing = new PostgresBillingRepository(runtime, { now: () => new Date("2026-10-07T12:00:00Z") });
    const legacy = await billing.ensureSubscription({ organizationId: orgA, actorUserId: ownerId });
    assert.equal(legacy.trial, null); assert.equal(subscriptionHasPremiumAccess(legacy), false);
    await billing.trials.authorize({ organizationId: orgA, actorUserId: viewerId });
    await assert.rejects(billing.trials.authorize({ organizationId: orgA, actorUserId: viewerId, owner: true }), { code: "ORG_ACCESS_DENIED" });
    await assert.rejects(billing.trials.authorize({ organizationId: orgB, actorUserId: ownerId }), { code: "ORG_ACCESS_DENIED" });
    const trial = { id: randomUUID(), organizationId: orgA, reference: `bnx_trial_${randomUUID()}`,
      status: "trialing", cardVerifiedAt: "2026-10-07T12:00:00Z", startedAt: "2026-10-07T12:00:00Z",
      endsAt: "2026-10-14T12:00:00Z", subscriptionCode: "SUB_synthetic_trial", customerCode: "CUS_synthetic",
      provisionStatus: "confirmed", refundStatus: "processed" };
    await billing.trials.withLock({ organizationId: orgA, actorUserId: ownerId }, async (repo) => {
      await repo.save({ organizationId: orgA, actorUserId: ownerId, trial, eventType: "trial.started" });
      await repo.publishSubscription({ organizationId: orgA, actorUserId: ownerId, trial });
      const current = await repo.billing.ensureSubscription({ organizationId: orgA, actorUserId: ownerId });
      assert.equal(subscriptionHasPremiumAccess(current, { now: () => new Date("2026-10-07T12:00:00Z") }), true);
      assert.equal(current.trial.authorization, undefined);
    });
    assert.equal((await billing.trials.get({ organizationId: orgB })), null);
    assert.equal((await runtime.query("select id from billing_trials")).rowCount, 0);
    await assert.rejects(withBillingTenant(runtime, { organizationId: orgB }, (client) => client.query(
      "insert into billing_trials (organization_id,reference,state) values ($1,$2,'{}')", [orgA, `bnx_trial_${randomUUID()}`],
    )), { code: "42501" });
    assert.equal(await billing.trials.resolve({ reference: trial.reference }), orgA);
    assert.deepEqual(await billing.trials.pendingOrganizations(), [orgA]);
    await assert.rejects(billing.trials.save({ organizationId: orgA, trial: { ...trial, endsAt: "2026-10-15T12:00:00Z" }, eventType: "invalid" }), { code: "23514" });
    await assert.rejects(billing.trials.save({ organizationId: orgA, trial: { ...trial, id: randomUUID(), reference: `bnx_trial_${randomUUID()}` }, eventType: "duplicate" }), { code: "BILLING_TRIAL_INELIGIBLE" });
    await assert.rejects(billing.recordPayment({ organizationId: orgA, reference: trial.reference, status: "success", amountMinor: 10000, currency: "NGN", paidAt: new Date() }), { code: "VALIDATION_FAILED" });
    const ignored = await billing.applyWebhookEvent({ organizationId: orgA, eventKey: "scheduled-only", eventName: "subscription.create", payload: "{}",
      action: "subscription_activated", providerSubscriptionCode: trial.subscriptionCode });
    assert.equal(ignored.action, "ignored");
    const audit = await withBillingTenant(runtime, { organizationId: orgA }, (client) => client.query("select event_type from billing_trial_audit"));
    assert.equal(audit.rowCount, 1);
    await assert.rejects(withBillingTenant(runtime, { organizationId: orgA }, (client) => client.query("update billing_trial_audit set event_type = 'tampered'")), { code: "42501" });
    await ownerPool.query((await readFile("db/migrations/0032_seven_day_trial.down.sql", "utf8")).replaceAll("biznoryx_app", runtimeRole));
    assert.equal((await ownerPool.query("select id from billing_trials")).rowCount, 1, "Rollback preserves trial evidence");
  } finally {
    if (runtime) await runtime.end();
    if (ownerPool) await ownerPool.end();
    if (databaseCreated) await admin.query(`drop database ${databaseName}`);
    if (roleCreated) await admin.query(`drop role ${runtimeRole}`);
    await admin.end();
  }
});
