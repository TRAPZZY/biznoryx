import { test, expect } from "@playwright/test";

for (const width of [1280, 375]) {
  test(`cancellation keeps confirmed state when email and payment history fail (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const subscription = {
      id: "synthetic-billing", status: "past_due", provider: "paystack", providerConfigured: true,
      canCancel: true, planName: "BIZNORYX Monthly", currency: "NGN", amountMinor: 4000000,
      currentPeriodEnd: "2026-12-01T00:00:00.000Z", priceLabel: "₦40,000/mo",
    };
    await page.route("**/api/dashboard", async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ json: { ...data, subscription } });
    });
    await page.route("**/api/billing/history", route => route.fulfill({ status: 503, json: { message: "Unavailable" } }));
    let cancellations = 0;
    await page.route("**/api/billing/cancel", route => {
      cancellations += 1;
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
    page.once("dialog", dialog => dialog.accept());
    await cancel.click();
    await expect(page.getByText("Subscription will not renew", { exact: true })).toBeVisible();
    await expect(page.locator("#billing-page-message")).toContainText("Subscription canceled. We couldn't send");
    await expect(page.getByText("Payment history is unavailable")).toBeVisible();
    await page.getByRole("button", { name: "Email cancellation confirmation", exact: true }).click();
    await expect(page.locator("#billing-page-message")).toContainText("Confirmation email submitted for delivery");
    expect(cancellations).toBe(2);
    await expect(cancel).toHaveCount(0);
  });
}
