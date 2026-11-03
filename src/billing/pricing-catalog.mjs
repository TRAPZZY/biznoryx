import { AuthError } from "../auth/core.mjs";

const monthlyPlans = Object.freeze([
  { id: "starter", name: "Starter", amountMinor: 590_000 },
  { id: "growth", name: "Growth", amountMinor: 1_290_000, recommended: true },
  { id: "business", name: "Business", amountMinor: 2_490_000 },
  { id: "business_plus", name: "Business Plus", amountMinor: 3_990_000 },
]);

export function tierPricingEnabled(env = process.env) {
  return env.BIZNORYX_TIER_PRICING_ENABLED === "true";
}

function providerCode(plan, env) {
  const code = String(env[`PAYSTACK_PLAN_CODE_${plan.id.toUpperCase()}`] ?? "").trim();
  return /^PLN_[a-z0-9]+$/i.test(code) ? code : null;
}

export function publicPricingCatalog(env = process.env) {
  const codes = monthlyPlans.map((plan) => providerCode(plan, env));
  const configured = tierPricingEnabled(env) && /^sk_(live|test)_/.test(env.PAYSTACK_SECRET_KEY ?? "") &&
    codes.every(Boolean) && new Set(codes).size === monthlyPlans.length &&
    !codes.includes(String(env.PAYSTACK_PLAN_CODE ?? "").trim());
  return monthlyPlans.map((plan) => ({
    ...plan,
    priceId: `${plan.id}_ngn_monthly_v1`,
    currency: "NGN",
    interval: "monthly",
    purchasable: configured,
  }));
}

export function resolveTierPrice(priceId, env = process.env) {
  const price = publicPricingCatalog(env).find((plan) => plan.priceId === priceId);
  if (!price?.purchasable) {
    throw new AuthError("Select an available monthly subscription plan.", "VALIDATION_FAILED");
  }
  return {
    id: price.priceId,
    name: price.name,
    amountMinor: price.amountMinor,
    currency: price.currency,
    interval: price.interval,
    planCode: providerCode(price, env),
    providerConfigured: true,
  };
}
