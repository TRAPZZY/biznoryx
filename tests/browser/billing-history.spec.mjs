import { test, expect } from "@playwright/test";

test("billing history loads from the API and shows an honest empty state", async ({ page }) => {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  const history = page.waitForResponse(
    (response) => response.url().endsWith("/api/billing/history") && response.ok(),
  );
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name: "Billing", exact: true })
    .click();
  await history;

  await expect(page.getByRole("heading", { name: "Billing history" })).toBeVisible();
  await expect(page.getByText("No completed payments yet")).toBeVisible();
  await expect(page.getByText("Loading payment history")).toHaveCount(0);

  // An unavailable API must not be shown as an empty (or paid) history.
  await page.route("**/api/billing/history", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.getByText("Payment history is unavailable")).toBeVisible();
});
