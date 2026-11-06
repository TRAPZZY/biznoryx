import { test, expect } from "@playwright/test";

for (const width of [1280, 375]) {
  test(`cancellation keeps confirmed state when email and payment history fail (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const subscription = {
      id: "synthetic-billing", status: width === 375 ? "active" : "past_due", provider: "paystack", providerConfigured: true,
      canCancel: true, planName: "Starter", planId: "starter_ngn_monthly_v1", currency: "NGN", amountMinor: 590000,
      currentPeriodEnd: "2026-12-01T00:00:00.000Z", priceLabel: "₦5,900/mo",
    };
    await page.route("**/api/dashboard", async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ json: { ...data, subscription } });
    });
    await page.route("**/api/billing/plans", route => route.fulfill({ json: {
      plans: [
        { priceId: "starter_ngn_monthly_v1", name: "Starter", amountMinor: 590000, purchasable: true },
        { priceId: "growth_ngn_monthly_v1", name: "Growth", amountMinor: 1290000, purchasable: true },
        { priceId: "business_ngn_monthly_v1", name: "Business", amountMinor: 2490000, purchasable: true },
        { priceId: "business_plus_ngn_monthly_v1", name: "Business Plus", amountMinor: 3990000, purchasable: true },
      ],
    } }));
    await page.route("**/api/billing/history", route => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
    let trialRequests = 0;
    await page.route("**/api/billing/trial", route => {
      trialRequests += 1;
      return route.fulfill({ status: 500, json: { message: "The request could not be completed." } });
    });
    let cancellations = 0;
    await page.route("**/api/billing/cancel*", route => {
      cancellations += 1;
      expect(route.request().url()).toMatch(cancellations === 1 ? /\/cancel$/ : /\/cancellation-confirmation$/);
      return route.fulfill({ json: {
        subscription: { ...subscription, status: "non_renewing", canCancel: false },
        confirmationEmail: { status: cancellations === 1 ? "failed" : "accepted" },
      } });
    });
    await page.goto("/#/sign-in");
    await page.getByLabel("Work email").fill("owner@biznoryx.local");
    await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/#/dashboard");
    await page.goto("/#/billing");
    const cancel = page.getByRole("button", { name: "Cancel subscription", exact: true });
    await expect(cancel).toBeEnabled();
    if (subscription.status === "active") {
      const plans = page.locator("[data-monthly-plans]");
      await expect(plans.getByText("Current plan", { exact: true })).toBeVisible();
      for (const name of ["Growth", "Business", "Business Plus"]) {
        await expect(plans.getByRole("button", { name: `Upgrade to ${name}`, exact: true })).toBeVisible();
      }
      await plans.getByRole("button", { name: "Upgrade to Growth", exact: true }).click();
      const upgrade = page.getByRole("dialog", { name: "Upgrade to Growth" });
      await expect(upgrade).toContainText("return to Billing");
      expect(cancellations).toBe(0);
      page.once("dialog", dialog => dialog.accept());
      await upgrade.getByRole("button", { name: "Turn off current renewal" }).click();
    } else {
      page.once("dialog", dialog => dialog.accept());
      await cancel.click();
    }
    await expect(page.getByText("Subscription will not renew", { exact: true })).toBeVisible();
    await expect(page.locator(".trial-billing")).toHaveCount(0);
    await expect(page.locator("#billing-page-message")).toContainText("Subscription canceled. We couldn't send");
    await expect(page.getByText("Payment history is unavailable")).toBeVisible();
    await page.getByRole("button", { name: "Email cancellation confirmation", exact: true }).click();
    await expect(page.locator("#billing-page-message")).toContainText("Confirmation email submitted for delivery");
    expect(cancellations).toBe(2);
    await expect(cancel).toHaveCount(0);
    subscription.status = "non_renewing";
    subscription.canCancel = false;
    const requestsBeforeReload = trialRequests;
    await page.reload();
    await expect(page.getByRole("button", { name: "Resume automatic renewal", exact: true })).toBeVisible();
    await expect(page.locator(".trial-billing")).toHaveCount(0);
    expect(trialRequests).toBe(requestsBeforeReload);
  });
}
