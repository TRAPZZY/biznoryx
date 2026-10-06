import { test, expect } from "@playwright/test";

import { acceptRequiredPolicy } from "./helpers/policy-onboarding.mjs";

async function createWorkspace(page) {
  await page.goto("/#/register");
  await page.getByLabel("Full name").fill("Evidence Browser Owner");
  await page
    .getByLabel("Work email")
    .fill(`evidence-${Date.now()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("EvidenceBrowserPassword2026!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email." }),
  ).toBeVisible();
  const code = await page.locator(".local-code strong").textContent();
  await page.getByLabel("Verification code").fill(code.trim());
  await page.getByLabel("Choose account password").fill("EvidenceBrowserPassword2026!");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await acceptRequiredPolicy(page);
  await expect(
    page.getByRole("heading", { name: "Make this workspace yours." }),
  ).toBeVisible();
  await page.getByLabel("Business name").fill("Evidence Browser Co");
  await page.getByLabel("Industry", { exact: true }).fill("Retail");
  await page
    .getByLabel("Business model", { exact: true })
    .fill("Product sales");
  await page
    .getByRole("button", { name: "Create business", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upload business data" }),
  ).toBeVisible();
}

test("evidence report analyzes dated source rows and exports from the UI", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const uniqueSeries = `Advanced evidence ${Date.now()}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createWorkspace(page);
  await page.getByLabel("Data series").fill(uniqueSeries);
  await page.getByLabel("Reporting month").fill("2026-03");
  await page.getByLabel("Metric column").fill("net_sales");
  await page.locator("input[type=file]").setInputFiles({
    name: "advanced-evidence.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "order_date,product_category,sales_channel,net_sales,profit_margin_percent,year",
        "2026-01-01,Core,Online,40.00,40,2026",
        "2026-01-31,Core,Online,60.00,39,2026",
        "2026-02-01,Core,Online,100.00,41,2026",
        "2026-02-28,Expansion,Partner,60.00,35,2026",
        "2026-03-01,Core,Online,145.00,42,2026",
        "2026-03-31,=FormulaLookalike,Partner,45.00,38,2026",
      ].join("\n"),
    ),
  });
  await page.getByRole("button", { name: "Validate files" }).click();
  await expect(
    page.getByRole("heading", { name: "Your data is ready to review." }),
  ).toBeVisible();
  await expect(page.locator(".validation-summary")).toContainText("$450.00");
  await page
    .getByRole("button", { name: "Confirm and add to dashboard" })
    .click();
  await expect(page.locator(".overview-v2-stats")).toBeVisible();

  await page
    .getByRole("link", { name: "Evidence reports", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Evidence behind every decision." }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "Performance evidence report",
  );
  await expect(page.getByRole("main")).toContainText("Net Sales rose");
  await expect(page.getByRole("main")).toContainText("$190.00");
  await expect(page.getByRole("main")).toContainText("=FormulaLookalike");
  await expect(page.locator(".er-chart").first()).toBeVisible();
  await expect(page.locator(".er-matrix")).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("sum(year)");

  const indicatorGrid = page.locator(".er-indicators");
  const desktopLayout = await indicatorGrid.evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
    firstCardFlow: getComputedStyle(element.children[0]).flexDirection,
  }));
  expect(desktopLayout).toEqual({ columns: 4, firstCardFlow: "column" });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileColumns = await indicatorGrid.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(mobileColumns).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 375, height: 812 });
  const narrowColumns = await indicatorGrid.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(narrowColumns).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Why this matters" }).first().click();
  await expect(
    page.getByRole("dialog", {
      name: /Why this conclusion appears|Start with/i,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Fact");
  await page.getByRole("button", { name: "Close evidence" }).click();

  await page.getByRole("button", { name: "Metric definition" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Define this metric" }),
  ).toBeVisible();
  await page.getByLabel("Business metric name").fill("Net sales");
  await page.getByLabel("When this metric increases").selectOption("higher");
  await page.getByLabel("Review changes of at least (%)").fill("5");
  await page
    .getByLabel(
      "I confirm this definition and that summing this column is appropriate.",
    )
    .check();
  await page.getByRole("button", { name: "Approve definition" }).click();
  await expect(page.locator(".er-status")).toContainText(
    "Metric definition approved",
  );
  await expect(page.getByRole("main")).toContainText("Definition v1");
  await expect(page.getByRole("main")).toContainText("Improving");

  for (const [name, pattern] of [
    ["Export PDF", /\.pdf$/],
    ["Shareable report", /\.html$/],
  ]) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(pattern);
  }
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export comparison CSV" }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
