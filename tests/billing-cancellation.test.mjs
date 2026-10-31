import assert from "node:assert/strict";
import test from "node:test";
import { createProductionApp } from "../src/webapp/production-app.mjs";
import { CancellationEmailSender } from "../src/billing/cancellation-email-sender.mjs";
import { disablePaystackSubscription } from "../src/billing/paystack.mjs";

async function fixture(t, overrides = {}) {
  const previous = { PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY, PAYSTACK_PLAN_CODE: process.env.PAYSTACK_PLAN_CODE };
  process.env.PAYSTACK_SECRET_KEY = "synthetic-cancellation-secret";
  delete process.env.PAYSTACK_PLAN_CODE;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let subscription = {
    id: "billing-1", organizationId: "org-1", provider: "paystack", status: "active",
    providerSubscriptionCode: "SUB_own", providerEmailToken: null, checkoutReference: null,
    planName: "BIZNORYX Monthly", currency: "NGN", amountMinor: 4000000,
    currentPeriodEnd: "2026-12-01T00:00:00.000Z", ...overrides.subscription,
  };
  const calls = [], emails = [];
  const { server } = createProductionApp({
    identityRepository: {
      async authenticate({ requireCsrf, csrfToken }) {
        if (requireCsrf) assert.equal(csrfToken, "csrf");
        return { user: { id: "owner-1", email: "owner@example.com" }, session: { activeOrganizationId: "org-1" } };
      },
      async activeMemberships() { return [{ organizationId: "org-1", role: overrides.role ?? "owner" }]; },
    },
    emailVerificationRepository: {},
    billingRepository: {
      async ensureSubscription() { return subscription; },
      async cancelSubscription(input) {
        calls.push("persist");
        if (overrides.persistenceFails) throw new Error("synthetic database failure");
        assert.equal(input.providerSubscriptionCode, "SUB_own");
        subscription = { ...subscription, status: "non_renewing", cancellationRequestedAt: "2026-10-31T12:00:00.000Z" };
        return subscription;
      },
    },
    billingEmailSender: {
      async sendCancellationConfirmation(input) {
        emails.push(input);
        if (overrides.emailFails) throw new Error("synthetic transport failure");
        return { messageId: "synthetic-message" };
      },
    },
    async paystackFetch(url, options) {
      calls.push(options.method);
      if (overrides.providerFails || (overrides.disableFails && options.method === "POST")) return Response.json({ status: false, message: "Provider unavailable" }, { status: 503 });
      if (options.method === "GET") return Response.json({ status: true, data: {
        subscription_code: "SUB_own", email_token: "synthetic-token", status: overrides.providerStatus ?? "active",
      } });
      assert.equal(String(url), "https://api.paystack.co/subscription/disable");
      assert.deepEqual(JSON.parse(options.body), { code: "SUB_own", token: "synthetic-token" });
      return Response.json({ status: true });
    },
    production: false,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, emails, get subscription() { return subscription; },
    async request(method = "POST", confirmationOnly = false) {
      const response = await fetch(`${base}/api/billing/${method === "GET" ? "subscription" : confirmationOnly ? "cancellation-confirmation" : "cancel"}`, {
        method, headers: { cookie: "bnx_session=synthetic", "x-csrf-token": "csrf" },
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("persisted subscription code enables cancellation without a checkout reference, token or current plan", async t => {
  const f = await fixture(t);
  const result = await f.request("GET");
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.canCancel, true);
});

test("cancellation recovers the saved identity, preserves paid access and sends confirmation after persistence", async t => {
  const f = await fixture(t);
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.status, "non_renewing");
  assert.equal(result.body.subscription.currentPeriodEnd, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(f.calls, ["GET", "POST", "persist"]);
  assert.equal(result.body.confirmationEmail.status, "accepted");
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].to, "owner@example.com");
  assert.equal(f.emails[0].subscription.status, "non_renewing");
  assert.equal(Object.hasOwn(result.body.subscription, "providerEmailToken"), false);
});

test("email failure does not undo cancellation or report cancellation failure", async t => {
  const f = await fixture(t, { emailFails: true });
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.status, "non_renewing");
  assert.equal(result.body.confirmationEmail.status, "failed");
});

test("an already non-renewing subscription can retry confirmation without a second provider cancellation", async t => {
  const f = await fixture(t, { subscription: { status: "non_renewing", cancellationRequestedAt: "2026-10-31T12:00:00.000Z" } });
  const result = await f.request("POST", true);
  assert.equal(result.status, 200);
  assert.equal(result.body.confirmationEmail.status, "accepted");
  assert.deepEqual(f.calls, []);
  assert.equal(f.emails.length, 1);
});

test("a stale email-only action never cancels a subscription reactivated in another tab", async t => {
  const f = await fixture(t);
  const result = await f.request("POST", true);
  assert.equal(result.status, 400);
  assert.equal(f.subscription.status, "active");
  assert.deepEqual(f.calls, []);
  assert.equal(f.emails.length, 0);
});

test("provider failure does not cancel locally or send a false confirmation", async t => {
  const f = await fixture(t, { providerFails: true });
  const result = await f.request();
  assert.equal(result.status, 502);
  assert.equal(f.subscription.status, "active");
  assert.equal(f.emails.length, 0);
  assert.ok(!f.calls.includes("persist"));
});

test("viewers cannot cancel or send billing emails", async t => {
  const f = await fixture(t, { role: "viewer" });
  assert.equal((await f.request()).status, 404);
  assert.deepEqual(f.calls, []);
  assert.equal(f.emails.length, 0);
});

test("a previously confirmed provider cancellation reconciles local state without disabling again", async t => {
  const f = await fixture(t, { providerStatus: "cancelled" });
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.status, "non_renewing");
  assert.deepEqual(f.calls, ["GET", "persist"]);
});

test("lost disable response reconciles only when the same provider subscription is non-renewing", async t => {
  const f = await fixture(t, { subscription: { providerEmailToken: "synthetic-token" }, disableFails: true, providerStatus: "non-renewing" });
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.status, "non_renewing");
  assert.deepEqual(f.calls, ["POST", "GET", "persist"]);
});

test("failed disable with still-active provider never produces a cancellation email", async t => {
  const f = await fixture(t, { subscription: { providerEmailToken: "synthetic-token" }, disableFails: true });
  const result = await f.request();
  assert.equal(result.status, 502);
  assert.equal(f.subscription.status, "active");
  assert.equal(f.emails.length, 0);
});

test("confirmation waits for local cancellation to commit", async t => {
  const f = await fixture(t, { persistenceFails: true });
  assert.equal((await f.request()).status, 500);
  assert.equal(f.emails.length, 0);
});

test("cancellation email has text and HTML, stable retry identity, and no provider tokens", async () => {
  const requests = [];
  const sender = new CancellationEmailSender({ apiKey: "synthetic", from: "BIZNORYX <office@example.com>",
    async fetchImpl(url, options) { requests.push({ url, ...options }); return Response.json({ id: "synthetic-message" }); },
  });
  const subscription = { id: "sub-1", status: "non_renewing", cancellationRequestedAt: "2026-10-31T12:00:00.000Z",
    currentPeriodEnd: "2026-12-01T00:00:00.000Z", providerEmailToken: "do-not-disclose" };
  await sender.sendCancellationConfirmation({ to: "owner@example.com", subscription });
  await sender.sendCancellationConfirmation({ to: "owner@example.com", subscription });
  const payload = JSON.parse(requests[0].body);
  assert.match(payload.subject, /subscription has been canceled/);
  for (const content of [payload.text, payload.html]) {
    assert.match(content, /Automatic renewal is off/);
    assert.match(content, /2026-12-01 00:00:00 UTC/);
    assert.doesNotMatch(content, /do-not-disclose/);
  }
  assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  await sender.sendCancellationConfirmation({ to: "owner@example.com", subscription: { ...subscription, cancellationRequestedAt: "2026-11-02T12:00:00.000Z" } });
  assert.notEqual(requests[0].headers["Idempotency-Key"], requests[2].headers["Idempotency-Key"]);
});

test("cancellation sender normalizes network and provider failures and rejects unconfirmed cancellation", async () => {
  for (const fetchImpl of [async () => { throw new Error("private details"); }, async () => Response.json({ error: "private details" }, { status: 503 })]) {
    const sender = new CancellationEmailSender({ apiKey: "synthetic", from: "BIZNORYX <office@example.com>", fetchImpl });
    await assert.rejects(sender.sendCancellationConfirmation({ to: "owner@example.com", subscription: { status: "non_renewing" } }), /Cancellation confirmation could not be sent/);
    await assert.rejects(sender.sendCancellationConfirmation({ to: "owner@example.com", subscription: { status: "active" } }), /Cancellation has not been confirmed/);
  }
});

for (const phase of ["headers", "body"]) {
  test(`Paystack cancellation times out when response ${phase} stall`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = disablePaystackSubscription({
      subscriptionCode: "SUB_own", emailToken: "synthetic-token", env: { PAYSTACK_SECRET_KEY: "synthetic" },
      async fetchImpl() {
        if (phase === "headers") return new Promise(() => {});
        return { ok: true, async json() { return new Promise(() => {}); } };
      },
    });
    const rejected = assert.rejects(pending, error => error.code === "BILLING_PROVIDER_FAILED" && /did not respond/.test(error.message));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(15000);
    await rejected;
  });
}
