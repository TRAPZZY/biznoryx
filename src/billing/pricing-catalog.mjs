const monthlyPlans = Object.freeze([
  Object.freeze({ id: "starter", name: "Starter", amountMinor: 590_000 }),
  Object.freeze({ id: "growth", name: "Growth", amountMinor: 1_290_000, recommended: true }),
  Object.freeze({ id: "business", name: "Business", amountMinor: 2_490_000 }),
  Object.freeze({ id: "business_plus", name: "Business Plus", amountMinor: 3_990_000 }),
]);

export function publicPricingCatalog() {
  return monthlyPlans.map((plan) => ({
    ...plan,
    priceId: `${plan.id}_ngn_monthly_v1`,
    currency: "NGN",
    interval: "monthly",
    purchasable: false,
  }));
}
