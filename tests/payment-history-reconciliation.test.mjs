import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePaymentHistory } from "../scripts/reconcile-payment-history.mjs";

const checkout = {
  organization_id: "org-A",
  provider: "paystack",
  reference: "synthetic-paid-A",
  status: "completed",
  amount_minor: 4000000,
  currency: "NGN",
};
const verified = {
  domain: "live",
  status: "success",
  reference: checkout.reference,
  amount: 4000000,
  currency: "NGN",
  paid_at: "2026-10-31T12:00:00.000Z",
  metadata: { organization_id: "org-A" },
};

test("historical payment reconciliation is read-only by default and explicitly excludes test payments", async () => {
  let writes = 0;
  const result = await reconcilePaymentHistory({
    organizationId: "org-A",
    checkouts: [checkout],
    verify: async () => verified,
    billing: {
      async recordPayment() {
        writes += 1;
      },
    },
  });
  assert.equal(result.records[0].result, "verified_live_dry_run");
  assert.equal(writes, 0);
  assert.ok(!JSON.stringify(result).includes(checkout.reference));
  const testPayment = await reconcilePaymentHistory({
    organizationId: "org-A",
    checkouts: [checkout],
    apply: true,
    verify: async () => ({ ...verified, domain: "test" }),
    billing: {
      async recordPayment() {
        writes += 1;
      },
    },
  });
  assert.equal(testPayment.records[0].result, "not_verified_live");
  assert.equal(writes, 0);
});

test("only matching provider-verified live payments are recorded without touching subscriptions", async () => {
  const writes = [];
  const result = await reconcilePaymentHistory({
    organizationId: "org-A",
    checkouts: [checkout],
    apply: true,
    verify: async () => verified,
    billing: {
      async recordPayment(input) {
        writes.push(input);
        return { ...input, paidAt: input.paidAt.toISOString() };
      },
    },
  });
  assert.equal(result.records[0].result, "recorded_or_already_present");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].amountMinor, 4000000);
  assert.equal(writes[0].paidAt.toISOString(), verified.paid_at);
});

test("reconciliation refuses foreign, mismatched, unverified and trial payments", async () => {
  for (const override of [
    { amount: 1 },
    { currency: "USD" },
    { reference: "other" },
    { status: "failed" },
    { paid_at: null },
    { metadata: { organization_id: "org-B" } },
    { metadata: "not JSON" },
  ]) {
    const result = await reconcilePaymentHistory({
      organizationId: "org-A",
      checkouts: [checkout],
      apply: true,
      verify: async () => ({ ...verified, ...override }),
      billing: {
        async recordPayment() {
          assert.fail("Must not save unverified history");
        },
      },
    });
    assert.ok(
      ["payment_mismatch", "invalid_metadata"].includes(
        result.records[0].result,
      ),
    );
  }
  for (const input of [
    { ...checkout, organization_id: "org-B" },
    { ...checkout, reference: "bnx_trial_example" },
  ]) {
    const result = await reconcilePaymentHistory({
      organizationId: "org-A",
      checkouts: [input],
      apply: true,
      verify: async () => assert.fail("Do not verify another tenant or trial"),
      billing: {},
    });
    assert.equal(result.records[0].result, "invalid_checkout");
  }
});

test("provider failures do not fabricate history or expose private errors", async () => {
  const result = await reconcilePaymentHistory({
    organizationId: "org-A",
    checkouts: [checkout],
    apply: true,
    verify: async () => {
      throw new Error("private-secret-details");
    },
    billing: {},
  });
  assert.equal(result.records[0].result, "verification_or_storage_failed");
  assert.ok(!JSON.stringify(result).includes("private-secret-details"));
});
