import assert from "node:assert/strict";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import {
  requirePremiumSubscription,
  subscriptionHasPremiumAccess,
} from "../src/billing/entitlements.mjs";
import { resolvePaystackSubscriptionIdentity } from "../src/billing/paystack.mjs";

const now = () => new Date("2026-10-05T12:00:00.000Z");
const past = "2026-10-05T11:59:59.999Z";
const future = "2026-10-05T12:00:00.001Z";
const env = { PAYSTACK_SECRET_KEY: "synthetic-billing-security-key" };

function providerFixture({
  transaction = {},
  subscriptions = [],
  details = {},
} = {}) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://api.paystack.co");
      assert.equal(options.method, "GET");
      calls.push(parsed.pathname);
      if (parsed.pathname === "/transaction/verify/paid-A") {
        return Response.json({
          status: true,
          data: {
            reference: "paid-A",
            status: "success",
            currency: "NGN",
            customer: { id: 123, metadata: { organization_id: "org-A" } },
            metadata: { organization_id: "org-A" },
            ...transaction,
          },
        });
      }
      if (parsed.pathname === "/subscription") {
        assert.equal(parsed.searchParams.get("customer"), "123");
        return Response.json({ status: true, data: subscriptions });
      }
      const code = decodeURIComponent(
        parsed.pathname.slice("/subscription/".length),
      );
      assert.ok(details[code], "Unexpected subscription detail request");
      return Response.json({ status: true, data: details[code] });
    },
  };
}

function subscription(code, organizationId, status = "active") {
  return {
    subscription_code: code,
    email_token: `synthetic-token-${code}`,
    customer: { id: 123 },
    plan: { plan_code: "PLN_shared" },
    status,
    metadata: organizationId ? { organization_id: organizationId } : null,
  };
}

function recover(provider, inputs = {}) {
  return resolvePaystackSubscriptionIdentity({
    reference: "paid-A",
    organizationId: "org-A",
    planCode: "PLN_shared",
    env,
    fetchImpl: provider.fetchImpl,
    ...inputs,
  });
}

function recoveryRejected(error) {
  return (
    error instanceof AuthError &&
    ["ORG_ACCESS_DENIED", "BILLING_PROVIDER_FAILED"].includes(error.code)
  );
}

test("premium access requires an unexpired paid period for both paid statuses", async (t) => {
  for (const status of ["active", "non_renewing"]) {
    for (const [label, currentPeriodEnd] of [
      ["missing", undefined],
      ["null", null],
      ["empty", ""],
      ["invalid", "not-a-date"],
      ["invalid Date", new Date(NaN)],
      ["numeric", Date.parse(future)],
      ["expired", past],
      ["boundary", now().toISOString()],
    ]) {
      await t.test(`${status}: ${label} denies access`, () => {
        assert.equal(
          subscriptionHasPremiumAccess({ status, currentPeriodEnd }, { now }),
          false,
        );
      });
    }
    assert.equal(
      subscriptionHasPremiumAccess(
        { status, currentPeriodEnd: future },
        { now },
      ),
      true,
    );
    assert.equal(
      subscriptionHasPremiumAccess(
        { status, currentPeriodEnd: new Date(future) },
        { now },
      ),
      true,
    );
  }
  for (const status of [
    "trialing",
    "pending_checkout",
    "past_due",
    "canceled",
  ]) {
    assert.equal(
      subscriptionHasPremiumAccess(
        { status, currentPeriodEnd: future },
        { now },
      ),
      false,
    );
  }
});

test("expired active subscriptions are rejected at the premium service boundary", async () => {
  const expired = { status: "active", currentPeriodEnd: past };
  await assert.rejects(
    requirePremiumSubscription({
      billingRepository: {
        async ensureSubscription() {
          return expired;
        },
      },
      organizationId: "org-A",
      now,
    }),
    (error) =>
      error instanceof AuthError && error.code === "SUBSCRIPTION_REQUIRED",
  );
  assert.equal(expired.currentPeriodEnd, past);
});

test("a shared customer and plan never bind an unrelated workspace subscription", async () => {
  const other = subscription("SUB_B", "org-B");
  const provider = providerFixture({
    subscriptions: [other],
    details: { SUB_B: other },
  });
  await assert.rejects(recover(provider), recoveryRejected);
  assert.ok(!provider.calls.includes("/subscription/SUB_B"));
});

test("fallback selects the workspace's inactive subscription over another workspace's active one", async () => {
  const own = subscription("SUB_A", "org-A", "cancelled");
  const other = subscription("SUB_B", "org-B");
  const provider = providerFixture({
    subscriptions: [own, other],
    details: { SUB_A: own, SUB_B: other },
  });
  const result = await recover(provider, { includeInactive: true });
  assert.equal(result.subscriptionCode, "SUB_A");
  assert.ok(!provider.calls.includes("/subscription/SUB_B"));
});

test("fallback only considers directly organization-bound candidates", async () => {
  const own = subscription("SUB_A", "org-A");
  const other = subscription("SUB_B", "org-B");
  const provider = providerFixture({
    subscriptions: [own, other],
    details: { SUB_A: own, SUB_B: other },
  });
  assert.equal((await recover(provider)).subscriptionCode, "SUB_A");
});

test("transaction or shared customer metadata alone cannot authorize a list candidate", async (t) => {
  for (const customerMetadata of [null, { organization_id: "org-A" }]) {
    await t.test(
      `candidate customer metadata ${customerMetadata ? "matches" : "missing"}`,
      async () => {
        const unbound = subscription("SUB_unbound", null);
        unbound.customer.metadata = customerMetadata;
        const provider = providerFixture({
          subscriptions: [unbound],
          details: { SUB_unbound: unbound },
        });
        await assert.rejects(recover(provider), recoveryRejected);
      },
    );
  }
});

test("direct subscription metadata supports JSON and organizationId without transaction metadata", async () => {
  const own = subscription("SUB_A", "org-A");
  own.metadata = JSON.stringify({ organizationId: "org-A" });
  const provider = providerFixture({
    transaction: { metadata: null },
    subscriptions: [own],
    details: { SUB_A: own },
  });
  assert.equal((await recover(provider)).subscriptionCode, "SUB_A");
});

test("fallback fails closed for ambiguous organization-bound subscriptions", async () => {
  const provider = providerFixture({
    subscriptions: [
      subscription("SUB_A1", "org-A"),
      subscription("SUB_A2", "org-A"),
    ],
  });
  await assert.rejects(recover(provider), recoveryRejected);
});

test("fallback rejects failed, mismatched, and foreign verification results", async (t) => {
  for (const transaction of [
    { status: "failed" },
    { reference: "paid-B" },
    { metadata: { organization_id: "org-B" } },
    { metadata: JSON.stringify({ organization_id: "org-B" }) },
  ]) {
    await t.test(JSON.stringify(transaction), async () => {
      const own = subscription("SUB_A", "org-A");
      const provider = providerFixture({
        transaction,
        subscriptions: [own],
        details: { SUB_A: own },
      });
      await assert.rejects(recover(provider), recoveryRejected);
      assert.deepEqual(provider.calls, ["/transaction/verify/paid-A"]);
    });
  }
});

test("persisted subscription codes recover directly without transaction or list guessing", async () => {
  const own = subscription("SUB_A", null, "cancelled");
  const provider = providerFixture({ details: { SUB_A: own } });
  assert.deepEqual(
    await recover(provider, {
      reference: null,
      expectedSubscriptionCode: "SUB_A",
      includeInactive: true,
    }),
    { subscriptionCode: "SUB_A", emailToken: "synthetic-token-SUB_A" },
  );
  assert.deepEqual(provider.calls, ["/subscription/SUB_A"]);
});

test("an unavailable persisted identity never falls back to another subscription", async () => {
  const calls = [];
  await assert.rejects(
    resolvePaystackSubscriptionIdentity({
      organizationId: "org-A",
      expectedSubscriptionCode: "SUB_missing",
      env,
      async fetchImpl(url) {
        calls.push(new URL(url).pathname);
        return Response.json({ status: false }, { status: 404 });
      },
    }),
    recoveryRejected,
  );
  assert.deepEqual(calls, ["/subscription/SUB_missing"]);
});

test("persisted recovery preserves subscriptions on a previous commercial plan", async () => {
  const own = subscription("SUB_A", null);
  own.plan.plan_code = "PLN_previous";
  const provider = providerFixture({ details: { SUB_A: own } });
  assert.equal(
    (
      await recover(provider, {
        expectedSubscriptionCode: "SUB_A",
        reference: null,
        planCode: "PLN_current",
      })
    ).subscriptionCode,
    "SUB_A",
  );
});

test("persisted recovery requires an organization and configured secret before provider calls", async (t) => {
  for (const overrides of [{ organizationId: null }, { env: {} }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const provider = providerFixture({
        details: { SUB_A: subscription("SUB_A", null) },
      });
      await assert.rejects(
        recover(provider, {
          expectedSubscriptionCode: "SUB_A",
          ...overrides,
        }),
        (error) => error instanceof AuthError,
      );
      assert.deepEqual(provider.calls, []);
    });
  }
});

test("detail responses must agree with the selected identity and workspace", async (t) => {
  for (const detail of [
    { subscription_code: "SUB_B" },
    { metadata: { organization_id: "org-B" } },
    { customer: { id: 456 } },
    { plan: { plan_code: "PLN_other" } },
    { email_token: "" },
  ]) {
    await t.test(JSON.stringify(detail), async () => {
      const own = subscription("SUB_A", "org-A");
      const provider = providerFixture({
        subscriptions: [own],
        details: { SUB_A: { ...own, ...detail } },
      });
      await assert.rejects(recover(provider), recoveryRejected);
    });
  }
});

test("persisted identities still reject conflicting workspace metadata and inactive status", async (t) => {
  for (const own of [
    subscription("SUB_A", "org-B"),
    subscription("SUB_A", null, "cancelled"),
  ]) {
    await t.test(
      `detail ${own.status} ${own.metadata?.organization_id ?? "unbound"}`,
      async () => {
        const provider = providerFixture({ details: { SUB_A: own } });
        await assert.rejects(
          recover(provider, { expectedSubscriptionCode: "SUB_A" }),
          recoveryRejected,
        );
        assert.deepEqual(provider.calls, ["/subscription/SUB_A"]);
      },
    );
  }
});
