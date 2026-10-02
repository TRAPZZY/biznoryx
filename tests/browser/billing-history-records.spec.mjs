import { test, expect } from "@playwright/test";

test("billing history renders verified payment records", async ({ page }) => {
  await page.route("**/api/billing/history", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        payments: [
          {
            reference: "bnx-renewal-2",
            provider: "paystack",
            status: "success",
            amountMinor: 4000000,
            currency: "NGN",
            channel: "card",
            paidAt: "2026-11-01T12:00:00.000Z",
          },
          {
            reference: "bnx-first-1",
            provider: "paystack",
            status: "success",
            amountMinor: 4000000,
            currency: "NGN",
            channel: "bank",
            paidAt: "2026-10-01T12:00:00.000Z",
          },
        ],
      }),
    }),
  );

  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Billing", exact: true })
    .click();

  const rows = page.locator(".billing-history-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("bnx-renewal-2");
  await expect(rows.nth(0)).toContainText("Paid");
  await expect(rows.nth(0)).toContainText("40,000");
  await expect(rows.nth(1)).toContainText("bnx-first-1");
  await expect(page.getByText("No completed payments yet")).toHaveCount(0);
});
