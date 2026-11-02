import { test, expect } from "@playwright/test";

async function harness(page, width) {
  await page.setViewportSize({ width, height: 950 });
  await page.goto("/privacy.html");
  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main style="max-width:1100px;margin:24px auto;padding:0 20px"><p>SYNTHETIC UI CHECK</p><div id="review-root"></div></main></body></html>',
  );
}
for (const width of [390, 1440])
  test(`reviewed import handles failure, retry and explicit confirmation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await harness(page, width);
    await page.evaluate(async () => {
      const { mountImportReview } = await import("/business-review.js");
      window.calls = [];
      let fail = true;
      mountImportReview({
        root: document.querySelector("#review-root"),
        uploads: [],
        payload: {
          fileName: "synthetic.csv",
          content: "date,amount\n2026-01-01,100.00\n",
          period: "2026-01",
          dataSeries: "Synthetic sales",
        },
        result: {
          profile: null,
          preview: {
            fileName: "synthetic.csv",
            rowCount: 1,
            columns: [{ name: "date" }, { name: "amount" }],
            previewRows: [["2026-01-01", "100.00"]],
            checksumSha256: "a".repeat(64),
            dataStream: { id: "synthetic-stream" },
          },
        },
        api: async (path, body) => {
          window.calls.push({ path, body });
          if (path === "ingestion/profile") {
            if (fail) {
              fail = false;
              throw new Error(
                "Mapping service is temporarily unavailable. Retry.",
              );
            }
            return {
              profile: {
                id: "synthetic-profile",
                version: 1,
                definition: body.definition,
              },
            };
          }
          if (path === "ingestion/reviewed")
            return { upload: { id: "synthetic-upload" } };
          throw Error("Unexpected request");
        },
        onComplete: async () => {
          document.querySelector("#review-root").textContent =
            "Synthetic import stored.";
        },
      });
    });
    await page.getByLabel("These records describe").selectOption("sales");
    await page
      .getByRole("combobox", { name: "Record date", exact: true })
      .selectOption("date");
    await page
      .getByRole("combobox", { name: "Amount column", exact: true })
      .selectOption("amount");
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "Approve mapping & import" })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "temporarily unavailable",
    );
    await expect(
      page.getByRole("button", { name: "Approve mapping & import" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`import-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Approve mapping & import" })
      .click();
    await expect(page.getByText("Synthetic import stored.")).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    expect(calls.filter((c) => c.path === "ingestion/reviewed")).toHaveLength(
      1,
    );
    expect(calls.at(-1).body.reviewedChecksum).toBe("a".repeat(64));
  });

test("sales/receipts and monthly review show responsive evidence and approval blockers", async ({
  page,
}, testInfo) => {
  await harness(page, 390);
  await page.evaluate(async () => {
    const { mountMoneyTrail } = await import("/business-review.js");
    await mountMoneyTrail({
      root: document.querySelector("#review-root"),
      uploads: [],
      api: async () => ({
        currency: "NGN",
        totals: {
          recordedSales: "100000.00",
          customerReceipts: "60000.00",
          allocatedReceipts: "60000.00",
          confirmedBalance: "40000.00",
          unallocatedReceipts: "0.00",
        },
        records: [],
        allocations: [],
        suggestions: [],
        sourceCorrections: [],
        limitations: [
          "Recorded sales are not profit.",
          "Missing payment evidence remains unknown.",
        ],
      }),
    });
  });
  await expect(
    page.getByRole("heading", { name: "Sales & receipts", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("₦40000.00", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("money-mobile.png"),
    fullPage: true,
  });
  await page.evaluate(async () => {
    const { mountMonthlyReview } = await import("/business-review.js");
    await mountMonthlyReview({
      root: document.querySelector("#review-root"),
      api: async (path) => {
        if (path === "monthly-close")
          return {
            items: [
              {
                id: "packet",
                period: "2026-01",
                version: 1,
                status: "draft",
                createdByName: "Synthetic owner",
                evidenceStatus: "available",
              },
            ],
          };
        if (path === "evidence-report") return { report: null };
        if (path.startsWith("monthly-close/sources"))
          return {
            options: [],
            checklist: { version: 0, period: "2026-01", sources: [] },
          };
        if (path.startsWith("monthly-close?id"))
          return {
            item: {
              id: "packet",
              period: "2026-01",
              version: 1,
              status: "draft",
              report: {
                metric: { label: "Recorded sales" },
                current: { value: "100000.00" },
              },
              evidenceStatus: "available",
              approvalBlockers: ["SOURCE_CHECKLIST_UNCONFIRMED"],
              limitations: [
                { message: "Source completeness has not been established." },
              ],
              contentHash: "a".repeat(64),
            },
          };
        throw Error("Unexpected request");
      },
    });
  });
  await page.getByRole("button", { name: "Open packet" }).click();
  await expect(
    page.getByRole("button", { name: "Approve this version" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Resolve before approval:", { exact: false }),
  ).toContainText("Confirm the required source checklist");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("monthly-mobile.png"),
    fullPage: true,
  });
});
