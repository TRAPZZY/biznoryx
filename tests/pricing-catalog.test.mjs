import assert from "node:assert/strict";
import test from "node:test";

import { publicPricingCatalog } from "../src/billing/pricing-catalog.mjs";

test("the public catalog lists all four monthly prices without enabling checkout", () => {
  const plans = publicPricingCatalog();
  assert.deepEqual(
    plans.map(({ id, amountMinor }) => [id, amountMinor]),
    [
      ["starter", 590000],
      ["growth", 1290000],
      ["business", 2490000],
      ["business_plus", 3990000],
    ],
  );
  assert.deepEqual(plans.filter(({ recommended }) => recommended).map(({ id }) => id), ["growth"]);
  assert.equal(new Set(plans.map(({ priceId }) => priceId)).size, 4);
  for (const plan of plans) {
    assert.equal(plan.currency, "NGN");
    assert.equal(plan.interval, "monthly");
    assert.equal(plan.purchasable, false);
    assert.equal(Object.hasOwn(plan, "planCode"), false);
  }
});

test("the local review server serves the catalog without authentication", async () => {
  const { createReviewApp } = await import("../src/webapp/review-app.mjs");
  const { server } = createReviewApp();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/billing/plans`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).plans, publicPricingCatalog());
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("tier price resolution requires four separate new Paystack plan codes", async () => {
  const { resolveTierPrice } = await import("../src/billing/pricing-catalog.mjs");
  const env = {
    BIZNORYX_TIER_PRICING_ENABLED: "true",
    PAYSTACK_SECRET_KEY: "sk_test_synthetic",
    PAYSTACK_PLAN_CODE: "PLN_legacy",
    PAYSTACK_PLAN_CODE_STARTER: "PLN_starter",
    PAYSTACK_PLAN_CODE_GROWTH: "PLN_growth",
    PAYSTACK_PLAN_CODE_BUSINESS: "PLN_business",
    PAYSTACK_PLAN_CODE_BUSINESS_PLUS: "PLN_businessplus",
  };

  const starter = resolveTierPrice("starter_ngn_monthly_v1", env);
  assert.equal(starter.amountMinor, 590000);
  assert.equal(starter.planCode, "PLN_starter");
  assert.throws(() => resolveTierPrice("starter_ngn_monthly_v1", {
    ...env, PAYSTACK_PLAN_CODE_STARTER: env.PAYSTACK_PLAN_CODE,
  }), { code: "VALIDATION_FAILED" });
  assert.throws(() => resolveTierPrice("starter_ngn_monthly_v1", {
    ...env, PAYSTACK_PLAN_CODE_STARTER: env.PAYSTACK_PLAN_CODE_GROWTH,
  }), { code: "VALIDATION_FAILED" });
});

test("paid plan feature gates are cumulative and preserve legacy access", async () => {
  const { requirePremiumSubscription } = await import("../src/billing/entitlements.mjs");
  const cases = [
    ["starter_ngn_monthly_v1", []],
    ["growth_ngn_monthly_v1", ["reportExport"]],
    ["business_ngn_monthly_v1", ["reportExport", "moneyTrail"]],
    ["business_plus_ngn_monthly_v1", ["reportExport", "moneyTrail", "monthlyClose"]],
    ["biznoryx_monthly_ngn_40000", ["reportExport", "moneyTrail", "monthlyClose"]],
  ];
  for (const [planId, allowed] of cases) {
    const subscription = { planId, status: "active", currentPeriodEnd: "2027-01-01T00:00:00Z" };
    const input = {
      billingRepository: { ensureSubscription: async () => subscription },
      organizationId: "org-a",
      now: () => new Date("2026-11-01T00:00:00Z"),
    };
    assert.equal(await requirePremiumSubscription(input), subscription);
    for (const feature of ["reportExport", "moneyTrail", "monthlyClose"]) {
      const result = requirePremiumSubscription({ ...input, feature });
      if (allowed.includes(feature)) assert.equal(await result, subscription);
      else await assert.rejects(result, { code: "SUBSCRIPTION_REQUIRED" });
    }
  }
});
