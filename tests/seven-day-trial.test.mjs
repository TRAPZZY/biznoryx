import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { subscriptionHasPremiumAccess } from "../src/billing/entitlements.mjs";
import { SevenDayTrialService, trialConfiguration, encryptTrialAuthorization, decryptTrialAuthorization } from "../src/billing/trial-service.mjs";

const env = {
  NODE_ENV: "production", PAYSTACK_SECRET_KEY: "synthetic-test-key", PAYSTACK_PLAN_CODE: "PLN_monthly",
  BIZNORYX_PUBLIC_URL: "https://app.example.com", BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR: "10000",
  BIZNORYX_BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
  RESEND_API_KEY: "synthetic-email-key", BIZNORYX_EMAIL_FROM: "billing@example.com",
};
const start = { organizationId: "org-A", actorUserId: "owner-A", email: "owner@example.com",
  callbackUrl: "https://app.example.com/billing/paystack/trial/callback", consent: true };
const nowDate = new Date("2026-10-07T12:00:00.000Z");
const rejected = (code) => (error) => error.code === code;

function fixture() {
  const rows = new Map();
  const events = [];
  const busy = new Set();
  const paid = new Set();
  const calls = [];
  let instant = new Date(nowDate);
  let providerSubscription;
  let refund;
  const subscription = { status: "trialing", amountMinor: 4_000_000, currency: "NGN", activeAt: null };
  const repo = {
    async authorize({ organizationId, actorUserId, owner }) {
      if (organizationId !== "org-A" || (owner ? actorUserId !== "owner-A" : !["owner-A", "viewer-A"].includes(actorUserId))) {
        const error = new Error("denied"); error.code = "ORG_ACCESS_DENIED"; throw error;
      }
    },
    async withLock(args, work) {
      if (args.actorUserId) await this.authorize({ ...args, owner: args.owner ?? true });
      if (busy.has(args.organizationId)) { const error = new Error("busy"); error.code = "BILLING_OPERATION_IN_PROGRESS"; throw error; }
      busy.add(args.organizationId);
      try { return await work(this); } finally { busy.delete(args.organizationId); }
    },
    async get({ organizationId }) { return structuredClone(rows.get(organizationId) ?? null); },
    async save({ organizationId, trial, eventType }) { rows.set(organizationId, structuredClone(trial)); events.push(eventType); },
    async hasPaidHistory() { return paid.size > 0 || Boolean(subscription.activeAt); },
    async publishSubscription({ trial }) { Object.assign(subscription, { status: "trialing", providerSubscriptionCode: trial.subscriptionCode }); },
    async resolve({ reference, subscriptionCode }) {
      return [...rows.values()].find((trial) => trial.reference === reference ||
        (subscriptionCode && trial.subscriptionCode === subscriptionCode))?.organizationId ?? null;
    },
    async pendingOrganizations() { return [...rows.keys()]; },
  };
  const plan = { id: 41, plan_code: "PLN_monthly", amount: 4_000_000, currency: "NGN", interval: "monthly" };
  const customer = { id: 51, email: start.email, customer_code: "CUS_A" };
  const authorization = { channel: "card", reusable: true, authorization_code: "AUTH_A" };
  const provider = {
    async plan() { calls.push("plan"); return { ...plan }; },
    async initialize(body) {
      calls.push({ initialize: body });
      return { reference: body.reference, authorization_url: "https://checkout.paystack.com/card-setup" };
    },
    async verify(reference) {
      calls.push({ verify: reference });
      const trial = rows.get("org-A");
      if (reference !== trial.reference) return { id: 71, reference, status: "success", amount: plan.amount,
        currency: "NGN", channel: "card", customer, authorization, paid_at: instant.toISOString() };
      return { id: 61, reference, status: "success", amount: trial.verificationAmountMinor,
        currency: "NGN", channel: "card", customer, authorization,
        metadata: { organization_id: trial.organizationId, actor_user_id: trial.actorUserId,
          trial_id: trial.id, billing_purpose: "trial_card_verification" } };
    },
    async createSubscription(body) {
      calls.push({ createSubscription: body });
      providerSubscription = { customer, plan, authorization, amount: plan.amount, status: "active",
        subscription_code: "SUB_A", email_token: "synthetic-provider-token", next_payment_date: body.start_date,
        createdAt: instant.toISOString() };
      return structuredClone(providerSubscription);
    },
    async listSubscriptions() { calls.push("listSubscriptions"); return providerSubscription ? [structuredClone(providerSubscription)] : []; },
    async subscription() { calls.push("subscription"); return structuredClone(providerSubscription); },
    async disable() { calls.push("disable"); providerSubscription.status = "non-renewing"; return {}; },
    async createRefund(body) {
      calls.push({ createRefund: body }); refund = { id: 81, transaction: 61, amount: 10000, currency: "NGN", status: "processed" }; return { ...refund };
    },
    async listRefunds() { calls.push("listRefunds"); return refund ? [{ ...refund }] : []; },
    async refund() { calls.push("refund"); return { ...refund }; },
  };
  const billing = {
    trials: repo,
    async ensureSubscription() {
      const trial = rows.get("org-A");
      return { ...subscription, trial: trial ? { ...trial, cardSetup: { verified: Boolean(trial.cardVerifiedAt) },
        providerProvisioned: Boolean(trial.subscriptionCode && trial.provisionStatus === "confirmed") } : null };
    },
    async recordPayment({ reference }) { assert.ok(!reference.startsWith("bnx_trial_")); paid.add(reference); },
    async applyWebhookEvent({ paidAt }) {
      subscription.status = "active";
      subscription.activeAt = paidAt;
      subscription.currentPeriodEnd = new Date(new Date(paidAt).getTime() + 28 * 86_400_000);
    },
  };
  const emails = [];
  const service = new SevenDayTrialService({ billingRepository: billing, env, provider, now: () => instant,
    fetchImpl: async (url, options) => { emails.push({ url, ...options }); return Response.json({ id: "email-1" }); } });
  return { rows, repo, events, calls, provider, subscription, billing, service, paid, emails,
    setNow(value) { instant = new Date(value); },
    getProviderSubscription() { return providerSubscription; },
    async begin() {
      const checkout = await service.startCheckout(start);
      return service.verifyCheckout({ ...start, reference: checkout.checkout.reference });
    },
    webhook(event) {
      const rawBody = Buffer.from(JSON.stringify(event));
      const signature = createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
      return service.handleWebhook({ event, rawBody, signature });
    },
  };
}

test("configuration requires explicit verification amount, secure origin, and independent AES key", () => {
  assert.equal(trialConfiguration(env).verificationAmountMinor, 10000);
  for (const override of [
    { BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR: undefined }, { BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR: "0" },
    { BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR: "4000000" }, { BIZNORYX_BILLING_ENCRYPTION_KEY: "weak" },
    { BIZNORYX_PUBLIC_URL: "http://app.example.com" }, { PAYSTACK_PLAN_CODE: "" },
  ]) assert.throws(() => trialConfiguration({ ...env, ...override }), rejected("BILLING_PROVIDER_NOT_CONFIGURED"));
});

test("AES-GCM binds authorization to organization and reference and rejects tampering", () => {
  const config = { key: trialConfiguration(env).key, organizationId: "org-A", reference: "ref-A" };
  const sealed = encryptTrialAuthorization({ code: "AUTH_A" }, config);
  assert.ok(!JSON.stringify(sealed).includes("AUTH_A"));
  assert.equal(decryptTrialAuthorization(sealed, config).code, "AUTH_A");
  assert.throws(() => decryptTrialAuthorization(sealed, { ...config, organizationId: "org-B" }));
  assert.throws(() => decryptTrialAuthorization(sealed, { ...config, reference: "ref-B" }));
  assert.throws(() => decryptTrialAuthorization({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, config));
});

test("hosted checkout requires consent and owner authorization and charges only disclosed card verification", async () => {
  const f = fixture();
  for (const override of [{ consent: false }, { consent: "true" }, { callbackUrl: "https://evil.example/billing/paystack/trial/callback" }]) {
    await assert.rejects(f.service.startCheckout({ ...start, ...override }));
  }
  await assert.rejects(f.service.startCheckout({ ...start, actorUserId: "viewer-A" }), rejected("ORG_ACCESS_DENIED"));
  await assert.rejects(f.service.startCheckout({ ...start, organizationId: "org-B" }), rejected("ORG_ACCESS_DENIED"));
  await assert.rejects(f.service.startCheckout({ ...start, actorUserId: null }), rejected("ORG_ACCESS_DENIED"));
  assert.equal(f.calls.length, 0);
  const first = await f.service.startCheckout(start);
  assert.equal(first.trial.verificationAmountMinor, 10000);
  assert.equal(first.trial.cardSetup.verified, false);
  const request = f.calls.find((call) => call.initialize).initialize;
  assert.equal(request.amount, 10000); assert.equal(request.currency, "NGN");
  assert.deepEqual(request.channels, ["card"]); assert.equal(request.plan, undefined);
  assert.deepEqual((await f.service.startCheckout(start)).checkout, first.checkout);
  assert.equal(f.calls.filter((call) => call.initialize).length, 1);
});

test("paid history and active legacy subscribers remain ineligible and unaffected", async () => {
  const f = fixture();
  Object.assign(f.subscription, { status: "active", activeAt: nowDate, currentPeriodEnd: "2026-11-01T00:00:00Z" });
  assert.equal((await f.service.getTrial(start)).eligible, false);
  await assert.rejects(f.service.startCheckout(start), rejected("BILLING_TRIAL_INELIGIBLE"));
  assert.equal(f.subscription.status, "active"); assert.equal(f.rows.size, 0);
  assert.equal(subscriptionHasPremiumAccess(f.subscription, { now: () => nowDate }), true);
});

test("seven-day access requires verified card and successful provisioning and expires at exact boundary", async () => {
  const f = fixture();
  assert.equal(subscriptionHasPremiumAccess({ status: "trialing", trialEndsAt: "2026-10-21" }, { now: () => nowDate }), false);
  const result = await f.begin();
  assert.equal(result.trial.eligible, false); assert.equal(result.trial.cardSetup.verified, true);
  assert.equal(result.trial.startedAt, "2026-10-07T12:00:00.000Z");
  assert.equal(result.trial.endsAt, "2026-10-14T12:00:00.000Z");
  assert.equal(result.trial.firstBillingDate, "2026-10-14T12:01:00.000Z"); assert.equal(result.trial.refundStatus, "processed");
  assert.equal(subscriptionHasPremiumAccess(result.subscription, { now: () => nowDate }), true);
  assert.equal(subscriptionHasPremiumAccess(result.subscription, { now: () => new Date("2026-10-14T11:59:59.999Z") }), true);
  assert.equal(subscriptionHasPremiumAccess(result.subscription, { now: () => new Date(result.trial.endsAt) }), false);
  assert.equal(subscriptionHasPremiumAccess({ ...result.subscription, trial: { ...result.subscription.trial, providerProvisioned: false } }), false);
  const create = f.calls.find((call) => call.createSubscription).createSubscription;
  assert.equal(create.authorization, "AUTH_A"); assert.equal(create.start_date, result.trial.firstBillingDate);
  assert.ok(!JSON.stringify(f.rows.get("org-A")).includes("AUTH_A"));
  assert.ok(!JSON.stringify(f.rows.get("org-A")).includes("synthetic-provider-token"));
  assert.ok(!JSON.stringify(result.trial).includes("authorization"));
  assert.equal(f.paid.size, 0);
});

test("exact checkout bindings reject foreign organization, actor, reference, customer, amount and currency", async (t) => {
  for (const patch of [
    { reference: "other" }, { amount: 1 }, { currency: "USD" }, { status: "failed" },
    { customer: { id: 51, customer_code: "CUS_B", email: "other@example.com" } },
    { metadata: { organization_id: "org-B" } }, { metadata: { organization_id: "org-A", actor_user_id: "other" } },
  ]) await t.test(JSON.stringify(patch), async () => {
    const f = fixture(); const checkout = await f.service.startCheckout(start);
    const verify = f.provider.verify.bind(f.provider);
    f.provider.verify = async (reference) => ({ ...(await verify(reference)), ...patch });
    await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }), rejected("BILLING_BINDING_MISMATCH"));
    assert.equal(f.calls.filter((call) => call.createSubscription || call.createRefund).length, 0);
    assert.equal(f.rows.get("org-A").cardVerifiedAt, undefined);
  });
});

test("non-reusable authorizations are refunded once and never provisioned", async (t) => {
  for (const patch of [{ reusable: false }, { reusable: "true" }, { channel: "bank" }, { authorization_code: "" }]) {
    await t.test(JSON.stringify(patch), async () => {
      const f = fixture(); const checkout = await f.service.startCheckout(start);
      const verify = f.provider.verify.bind(f.provider);
      f.provider.verify = async (reference) => { const value = await verify(reference); return { ...value, authorization: { ...value.authorization, ...patch } }; };
      for (let i = 0; i < 2; i += 1) await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }), rejected("BILLING_CARD_NOT_REUSABLE"));
      assert.equal(f.calls.filter((call) => call.createSubscription).length, 0);
      assert.equal(f.calls.filter((call) => call.createRefund).length, 1);
    });
  }
});

test("duplicate verification and signed webhook replays neither provision nor refund twice", async () => {
  const f = fixture(); await f.begin(); const trial = f.rows.get("org-A");
  await f.service.verifyCheckout({ ...start, reference: trial.reference });
  for (let i = 0; i < 2; i += 1) {
    const response = await f.webhook({ event: "charge.success", data: { reference: trial.reference, status: "success" } });
    assert.equal(response.handled, true);
  }
  assert.equal(f.calls.filter((call) => call.createSubscription).length, 1);
  assert.equal(f.calls.filter((call) => call.createRefund).length, 1);
  assert.equal(f.paid.size, 0);
  assert.equal((await f.webhook({ event: "subscription.create", data: { subscription_code: "SUB_A" } })).action, "trial_scheduled");
  assert.equal(f.subscription.status, "trialing");
  await assert.rejects(f.service.handleWebhook({ rawBody: Buffer.from("{}"), signature: "bad" }), rejected("ORG_ACCESS_DENIED"));
});

test("ambiguous subscription creation recovers existing exact binding without a second POST", async () => {
  const f = fixture(); const create = f.provider.createSubscription.bind(f.provider);
  f.provider.createSubscription = async (body) => { await create(body); throw new Error("connection lost after provider success"); };
  const checkout = await f.service.startCheckout(start);
  await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }));
  assert.equal(f.rows.get("org-A").provisionStatus, "attempted");
  assert.equal(subscriptionHasPremiumAccess(await f.billing.ensureSubscription(), { now: () => nowDate }), false);
  await f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference });
  assert.equal(f.calls.filter((call) => call.createSubscription).length, 1);
  assert.equal(f.rows.get("org-A").status, "trialing");
});

test("ambiguous provider absence never blindly retries provisioning or grants access", async () => {
  const f = fixture(); f.provider.createSubscription = async () => { throw new Error("timeout"); };
  const checkout = await f.service.startCheckout(start);
  await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }));
  await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }), rejected("BILLING_RECONCILIATION_REQUIRED"));
  assert.equal(f.rows.get("org-A").startedAt, undefined);
});

test("refund lost-response recovery uses provider lookup and never submits a second refund", async () => {
  const f = fixture(); const create = f.provider.createRefund.bind(f.provider);
  f.provider.createRefund = async (body) => { await create(body); throw new Error("response lost"); };
  const checkout = await f.service.startCheckout(start);
  await assert.rejects(f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference }));
  assert.equal(f.rows.get("org-A").refundStatus, "attempted");
  await f.service.verifyCheckout({ ...start, reference: checkout.checkout.reference });
  assert.equal(f.calls.filter((call) => call.createRefund).length, 1);
  assert.equal(f.rows.get("org-A").refundStatus, "processed");
});

test("cancel disables scheduled provider charge, retains access to expiry, and repeats safely", async () => {
  const f = fixture(); await f.begin();
  const result = await f.service.cancelTrial(start);
  assert.equal(result.trial.cancellationStatus, "confirmed"); assert.equal(result.trial.canCancel, false);
  assert.equal(subscriptionHasPremiumAccess(result.subscription, { now: () => nowDate }), true);
  assert.equal(f.getProviderSubscription().status, "non-renewing");
  await f.service.cancelTrial(start);
  assert.equal(f.calls.filter((call) => call === "disable").length, 1);
  await assert.rejects(f.service.startCheckout(start), rejected("BILLING_TRIAL_INELIGIBLE"));
  f.setNow(result.trial.endsAt);
  assert.equal((await f.service.getTrial(start)).status, "expired");
  assert.equal(subscriptionHasPremiumAccess(result.subscription, { now: () => new Date(result.trial.endsAt) }), false);
});

test("failed cancellation is durably pending and worker retries safely after response loss", async () => {
  const f = fixture(); await f.begin(); const disable = f.provider.disable.bind(f.provider);
  f.provider.disable = async () => { await disable(); throw new Error("response lost"); };
  await assert.rejects(f.service.cancelTrial(start));
  assert.equal(f.rows.get("org-A").cancelStatus, "requested");
  assert.equal(f.rows.get("org-A").canceledAt, undefined);
  await f.service.processPending({ organizationId: "org-A" });
  assert.equal(f.rows.get("org-A").cancelStatus, "confirmed");
  assert.equal(f.calls.filter((call) => call === "disable").length, 1);
});

test("only exact qualifying actual paid charge after first billing date activates subscription", async () => {
  const f = fixture(); const result = await f.begin();
  const event = { event: "invoice.update", data: { paid: true, subscription: { subscription_code: "SUB_A" }, transaction: { reference: "paid-A" } } };
  await assert.rejects(f.webhook(event), rejected("BILLING_BINDING_MISMATCH"));
  assert.equal(f.paid.size, 0);
  f.setNow(result.trial.firstBillingDate);
  await f.webhook(event);
  assert.equal(f.subscription.status, "active"); assert.equal(f.paid.size, 1);
  assert.equal((await f.service.getTrial(start)).status, "converted");
  assert.equal((await f.webhook(event)).handled, false);
});

test("failed first subscription charge exposes payment update state without local charging", async () => {
  const f = fixture(); await f.begin(); f.getProviderSubscription().status = "attention";
  await f.webhook({ event: "invoice.payment_failed", data: { subscription: { subscription_code: "SUB_A" } } });
  assert.equal((await f.service.getTrial(start)).paymentUpdateRequired, true);
  assert.equal(f.subscription.status, "trialing"); assert.equal(f.paid.size, 0);
});

test("pending worker delivers one pre-expiry reminder and never reminds canceled trials", async () => {
  const f = fixture(); await f.begin(); f.setNow("2026-10-13T12:00:00Z");
  await f.service.processPending({ organizationId: "org-A" });
  await f.service.processPending({ organizationId: "org-A" });
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].headers["Idempotency-Key"], `trial-reminder/${f.rows.get("org-A").id}`);
  const second = fixture(); await second.begin(); await second.service.cancelTrial(start);
  second.setNow("2026-10-13T12:00:00Z"); await second.service.processPending({ organizationId: "org-A" });
  assert.equal(second.emails.length, 0);
});
