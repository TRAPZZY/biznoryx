import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { PostgresBillingRepository, withBillingTenant } from "../src/database/billing-repository.mjs";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { createPostgresPool } from "../src/database/postgres.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

test("signed webhooks resolve persisted subscription ownership without customer metadata", async () => {
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "synthetic-webhook-security-secret";
  const lookups = [];
  const changes = [];
  const { server } = createProductionApp({
    production: false,
    identityRepository: {},
    emailVerificationRepository: {},
    billingRepository: {
      async organizationForSubscription({ providerSubscriptionCode }) {
        lookups.push(providerSubscriptionCode);
        return providerSubscriptionCode === "SUB_current" ? "org-1" : null;
      },
      async ensureSubscription({ organizationId }) {
        assert.equal(organizationId, "org-1");
        return { status: "active", providerSubscriptionCode: "SUB_current" };
      },
      async applyWebhookEvent(input) { changes.push(input); return { duplicate: false, action: input.action }; },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function webhook(data, signature = null) {
    const payload = JSON.stringify({ event: "invoice.payment_failed", data });
    return fetch(`${base}/api/billing/paystack/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature ?? createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(payload).digest("hex") },
      body: payload,
    });
  }
  try {
    const unsigned = await webhook({ subscription: { subscription_code: "SUB_current" } }, "0".repeat(128));
    assert.equal(unsigned.status, 401);
    assert.equal(lookups.length, 0);
    const valid = await webhook({ id: 1, subscription: { subscription_code: "SUB_current" }, customer: { metadata: null } });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).action, "subscription_past_due");
    assert.equal(changes[0].organizationId, "org-1");
    assert.equal(changes[0].providerSubscriptionCode, "SUB_current");
    const conflict = await webhook({ subscription: { subscription_code: "SUB_current" }, metadata: { organization_id: "org-2" } });
    assert.equal(conflict.status, 404);
    const retired = await webhook({ subscription: { subscription_code: "SUB_retired" } });
    assert.equal(retired.status, 200);
    assert.equal((await retired.json()).action, "ignored");
    assert.equal(changes.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousSecret;
  }
});

test("PostgreSQL billing rejects retired identities, duplicate provider bindings and stale paid periods", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test" });
  const now = () => new Date("2026-10-05T00:00:00.000Z");
  const identity = new PostgresIdentityRepository(pool, { now });
  const billing = new PostgresBillingRepository(pool, { now });
  const suffix = randomUUID();
  try {
    const user = await identity.createUser({ email: `billing-security-${suffix}@example.test`, displayName: "Security test", password: "SecurityAuditPassphrase2026!" });
    const org = await identity.createOrganization({ actorUserId: user.id, name: "Billing security test", slug: `security-${suffix}` });
    const tenant = { organizationId: org.id, actorUserId: user.id };
    await billing.ensureSubscription(tenant);
    const code = `SUB_${suffix}`;
    await billing.createCheckoutSession({ ...tenant, provider: "paystack", reference: `checkout-${suffix}` });
    const activated = await billing.applyWebhookEvent({ organizationId: org.id, eventKey: `activation-${suffix}`, eventName: "charge.success", reference: `checkout-${suffix}`, payload: "synthetic", action: "subscription_activated", providerSubscriptionCode: code, paidAt: new Date("2026-09-20T00:00:00.000Z") });
    assert.equal(activated.action, "subscription_activated");
    assert.equal((await billing.ensureSubscription(tenant)).currentPeriodEnd.toISOString(), "2026-10-20T00:00:00.000Z");
    assert.equal(await billing.organizationForSubscription({ providerSubscriptionCode: code }), org.id);

    const oldEvent = await billing.applyWebhookEvent({ organizationId: org.id, eventKey: `retired-${suffix}`, eventName: "subscription.disable", payload: "synthetic", action: "subscription_canceled", providerSubscriptionCode: `SUB_retired_${suffix}` });
    assert.equal(oldEvent.action, "ignored");
    let current = await billing.ensureSubscription(tenant);
    assert.equal(current.status, "active");
    assert.equal(current.providerSubscriptionCode, code);

    const stalePayment = await billing.applyWebhookEvent({ organizationId: org.id, eventKey: `stale-${suffix}`, eventName: "invoice.update", reference: `invoice-${suffix}`, payload: "synthetic", action: "subscription_renewed", providerSubscriptionCode: code, paidAt: new Date("2026-08-20T00:00:00.000Z") });
    assert.equal(stalePayment.action, "ignored");
    assert.equal((await billing.ensureSubscription(tenant)).currentPeriodEnd.toISOString(), "2026-10-20T00:00:00.000Z");

    const failureInput = { organizationId: org.id, eventKey: `failure-${suffix}`, eventName: "invoice.payment_failed", payload: "synthetic", action: "subscription_past_due", providerSubscriptionCode: code };
    assert.equal((await billing.applyWebhookEvent(failureInput)).action, "subscription_past_due");
    assert.equal((await billing.applyWebhookEvent(failureInput)).duplicate, true);
    assert.equal((await billing.ensureSubscription(tenant)).status, "past_due");

    const otherOrg = await identity.createOrganization({ actorUserId: user.id, name: "Other security workspace", slug: `other-security-${suffix}` });
    const otherTenant = { organizationId: otherOrg.id, actorUserId: user.id };
    await billing.ensureSubscription(otherTenant);
    await assert.rejects(withBillingTenant(pool, otherTenant, (client) => client.query(
      "update organization_billing_subscriptions set provider_subscription_code = $2 where organization_id = $1",
      [otherOrg.id, code],
    )), (error) => error.code === "23505");
  } finally {
    await pool.end();
  }
});
