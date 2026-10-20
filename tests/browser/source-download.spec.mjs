import { readFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { parse } from "csv-parse/sync";
import { createReviewApp } from "../../src/webapp/review-app.mjs";

const test = base.extend({
  baseURL: async ({}, use) => {
    const { server } = createReviewApp();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
});

async function signIn(page) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#workspace-sidebar")).toBeAttached();
  await page.goto("/#/data");
  await expect(page.getByRole("heading", { name: "Source files" })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`uploaded source downloads unchanged with error and retry states at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await signIn(page);
    await expect(page.getByText("No source files yet.")).toBeVisible();
    const bytes = Buffer.from('date,product,quantity,revenue\r\n2026-10-01,"Caf\u00e9, large",2,120.00\r\n');
    await page.locator('input[name="file"]').setInputFiles({ name: "caf\u00e9 sales.csv", mimeType: "text/csv", buffer: bytes });
    await page.locator('input[name="period"]').fill("2026-10");
    await page.getByRole("button", { name: "Validate files", exact: true }).click();
    const button = page.getByRole("button", { name: "Download caf\u00e9 sales.csv", exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator("svg")).toHaveCount(1);
    const pattern = "**/api/ingestion/uploads/*/download";
    await page.route(pattern, route => route.fulfill({ status: 503, json: { message: "Storage is temporarily unavailable. Try again." } }));
    await button.click();
    await expect(page.locator("#source-download-message")).toContainText("temporarily unavailable");
    await expect(button).toBeEnabled();
    await page.unroute(pattern);
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route(pattern, async route => { await waiting; await route.continue(); });
    const downloadPromise = page.waitForEvent("download");
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
    release();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("caf\u00e9 sales.csv");
    expect(await readFile(await download.path())).toEqual(bytes);
    await expect(button).toBeEnabled();
    await expect(page.locator("#source-download-message")).toContainText("Downloaded");
    await page.locator("#upload-history").screenshot({ path: info.outputPath(`source-files-${width}.png`) });
    await page.reload();
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });

  test(`submitted spreadsheet records appear immediately as downloadable CSV at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.getByRole("tab", { name: "Enter data" }).click();
    await page.locator("#entry-series").fill("Daily records");
    await page.locator("#entry-series").press("Tab");
    await page.locator("#entry-period").fill("2026-10");
    await page.getByLabel("Row 1, date", { exact: true }).fill("2026-10-20");
    await page.getByLabel("Row 1, product", { exact: true }).fill('Service, "monthly"');
    await page.getByLabel("Row 1, quantity", { exact: true }).fill("2");
    await page.getByLabel("Row 1, revenue", { exact: true }).fill("75.50");
    await page.getByRole("button", { name: "Review and submit", exact: true }).click();
    await page.getByRole("button", { name: "Submit records", exact: true }).click();
    await expect(page.locator("#entry-status")).toContainText("Records submitted");
    const button = page.getByRole("button", { name: "Download manual-2026-10.csv", exact: true });
    await expect(button).toBeVisible();
    const pending = page.waitForEvent("download");
    await button.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("manual-2026-10.csv");
    const rows = parse(await readFile(await download.path()), { columns: true, bom: true });
    expect(rows).toEqual([{ date: "2026-10-20", product: 'Service, "monthly"', quantity: "2", revenue: "75.50" }]);
    await page.locator("#upload-history").screenshot({ path: info.outputPath(`manual-source-${width}.png`) });
    await page.getByRole("tab", { name: "Upload file" }).click();
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
