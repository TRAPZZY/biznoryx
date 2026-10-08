import { test, expect } from "@playwright/test";

async function signIn(page, path) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#workspace-sidebar")).toBeAttached();
  await page.goto(`/#/${path}`);
}

for (const width of [1440, 390]) {
  test(`manual records persist, validate and accumulate at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, "data");
    await page.getByRole("tab", { name: "Enter data" }).click();
    const series = `Browser entries ${width} ${Date.now()}`;
    await page.locator("#entry-period").fill("2026-10");
    await page.locator("#entry-series").fill(series);
    await page.locator("#entry-series").press("Tab");
    await page.getByLabel("Row 1, date", { exact: true }).evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "2026-10-01\tWidget\tbad\t100.10\n2026-10-02\tService\t2\t50.20");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    await expect(page.getByLabel("Row 2, revenue", { exact: true })).toHaveValue("50.20");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByLabel("Row 2, revenue", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByRole("button", { name: "Review and submit", exact: true }).click();
    await expect(page.getByLabel("Row 1, quantity", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Row 1, quantity", { exact: true }).fill("1");
    await expect(page.getByRole("button", { name: "Move date left", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.locator("#entry-status")).toHaveText("Draft saved");
    const response = await page.request.get("/api/ingestion/manual");
    const draft = (await response.json()).drafts.find((entry) => entry.dataSeries === series);
    expect(draft).toBeTruthy();
    await page.reload();
    await page.getByRole("tab", { name: "Enter data" }).click();
    await page.getByLabel("Saved drafts").selectOption(draft.id);
    await expect(page.getByLabel("Row 1, quantity", { exact: true })).toHaveValue("1");
    await page.screenshot({ path: info.outputPath("manual-grid.png"), fullPage: true });
    await page.getByRole("button", { name: "Review and submit", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const submission = page.waitForResponse((res) => res.url().endsWith("/api/ingestion/manual/submit"));
    await page.getByRole("button", { name: "Submit records", exact: true }).click();
    const submitted = await submission;
    expect(submitted.ok(), await submitted.text()).toBeTruthy();
    await expect(page.locator("#entry-status")).toContainText("Records submitted");
    await page.getByLabel("Row 1, date", { exact: true }).fill("2026-10-03");
    await page.getByLabel("Row 1, product", { exact: true }).fill("Extra");
    await page.getByLabel("Row 1, quantity", { exact: true }).fill("1");
    await page.getByLabel("Row 1, revenue", { exact: true }).fill("20.30");
    await page.getByRole("button", { name: "Review and submit", exact: true }).click();
    await page.getByRole("button", { name: "Submit records", exact: true }).click();
    await expect(page.locator("#entry-status")).toContainText("Records submitted");
    const dashboard = await (await page.request.get("/api/dashboard")).json();
    const monthly = dashboard.uploads.find((entry) => entry.dataSeries === series && entry.status === "confirmed");
    expect(monthly.rowCount).toBe(3);
    expect(Number(monthly.metricValue)).toBe(170.6);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("trial billing presents consent, pending verification, cancellation and payment recovery", async ({ page }, info) => {
  let trial = { eligible: true, configured: true, canStartCheckout: true, status: "eligible", verificationAmountMinor: 10000, currency: "NGN" };
  await page.route("**/api/billing/trial", (route) => route.fulfill({ json: { trial } }));
  await signIn(page, "billing");
  await expect(page.getByRole("button", { name: "Start seven-day trial" })).toBeDisabled();
  await expect(page.locator(".trial-billing")).toContainText("charged to verify your card");
  await page.locator("#trial-consent").check();
  await expect(page.getByRole("button", { name: "Start seven-day trial" })).toBeEnabled();
  trial = { ...trial, eligible: false, status: "pending_checkout", checkoutReference: "bnx_trial_browser", canVerify: true };
  await page.reload();
  await expect(page.getByRole("button", { name: "Continue card setup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check card verification" })).toBeVisible();
  await page.route("**/api/billing/trial/verify", (route) => route.fulfill({ status: 502, json: { message: "Paystack is temporarily unavailable." } }));
  await page.getByRole("button", { name: "Check card verification" }).click();
  await expect(page.locator("#trial-message")).toContainText("temporarily unavailable");
  const end = new Date(Date.now() + 6 * 86_400_000).toISOString();
  trial = { ...trial, canStartCheckout: false, canVerify: false, status: "trialing", startedAt: new Date().toISOString(), endsAt: end,
    firstBillingDate: end, providerProvisioned: true, canCancel: true, refundStatus: "processed" };
  await page.reload();
  await expect(page.getByRole("button", { name: "Cancel trial billing", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("trial-billing-desktop.png"), fullPage: true });
  let canceled = 0;
  await page.route("**/api/billing/trial/cancel", (route) => {
    canceled += 1; trial = { ...trial, canceledAt: new Date().toISOString(), canCancel: false };
    return route.fulfill({ json: { trial } });
  });
  await page.getByRole("button", { name: "Cancel trial billing", exact: true }).click();
  expect(canceled).toBe(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel trial billing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trial cancellation confirmed" })).toBeVisible();
  expect(canceled).toBe(1);
  trial = { ...trial, canceledAt: null, status: "expired", endsAt: new Date(Date.now() - 1000).toISOString(), paymentUpdateAvailable: true };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Update payment card" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("trial-billing-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
