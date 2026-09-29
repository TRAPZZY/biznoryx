import { test, expect } from "@playwright/test";

async function signIn(page) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page
    .getByLabel("Password", { exact: true })
    .fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your business, in perspective." }),
  ).toBeVisible();
}

async function navigate(page, name, path, heading) {
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("link", { name, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/${path}$`));
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace", exact: true })
      .getByRole("link", { name, exact: true }),
  ).toHaveClass(/active/);
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test.describe(`navigation at ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const [name, path, heading] of [
      ["Product", "product", "A business performance system, not a spreadsheet wrapper."],
      ["Solutions", "solutions", "Built for owners who need to understand what changed."],
      ["Pricing", "pricing", "$20 per month for the BIZNORYX business workspace."],
      ["Security", "security", "Tenant isolation and auditability are part of the product."],
      ["Resources", "resources", "How teams build a useful business memory."],
    ]) {
      test(`landing link: ${name}`, async ({ page }) => {
        await page.goto("/");
        await page
          .getByRole("navigation", { name: "Main navigation", exact: true })
          .getByRole("link", { name, exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`#/${path}$`));
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
      });
    }

    test("auth links return home and switch between forms", async ({
      page,
    }) => {
      await page.goto("/");
      await page
        .locator("header")
        .getByRole("link", { name: "Sign in", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/sign-in$/);
      await expect(
        page.getByRole("heading", { name: "Good to see you again." }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Back to home" }).click();
      await expect(
        page.getByRole("heading", { name: "BIZNORYX", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "$20/mo start" }).click();
      await expect(page).toHaveURL(/#\/register$/);
      await expect(page.getByLabel("Full name")).toBeVisible();
      await page.getByRole("link", { name: "Back to home" }).click();
      await expect(
        page.getByRole("heading", { name: "BIZNORYX", exact: true }),
      ).toBeVisible();
      await page
        .locator("header")
        .getByRole("link", { name: "$20/mo start", exact: true })
        .click();
      await page
        .locator(".auth-switch")
        .getByRole("link", { name: "Sign in", exact: true })
        .click();
      await expect(page).toHaveURL(/#\/sign-in$/);
      await expect(page.getByLabel("Full name")).toHaveCount(0);
      await page.getByRole("link", { name: "Create an account" }).click();
      await expect(page).toHaveURL(/#\/register$/);
      await expect(page.getByLabel("Full name")).toBeVisible();
    });

    test("bad credentials can be corrected to sign in", async ({ page }) => {
      await page.goto("/#/sign-in");
      await page.getByLabel("Work email").fill("owner@biznoryx.local");
      await page
        .getByLabel("Password", { exact: true })
        .fill("IncorrectPassphrase2026!");
      const rejected = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/sign-in") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      expect((await rejected).status()).toBe(401);
      await expect(page.getByRole("status")).toHaveText("Invalid credentials.");
      await expect(page).toHaveURL(/#\/sign-in$/);
      await expect(
        page.getByRole("navigation", { name: "Workspace", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeEnabled();
      await page
        .getByLabel("Password", { exact: true })
        .fill("ReviewPassphrase2026!");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/#\/dashboard$/);
      await expect(
        page.getByRole("heading", { name: "Your business, in perspective." }),
      ).toBeVisible();
      await expect(page.getByLabel("Business", { exact: true })).toContainText(
        "Acme Retail Group",
      );
    });

    test("workspace links and browser back restore the expected views", async ({
      page,
    }) => {
      await signIn(page);
      await navigate(
        page,
        "Business profile",
        "business",
        "Business profile",
      );
      await expect(page.getByLabel("Industry", { exact: true })).toBeVisible();
      await navigate(page, "Data & uploads", "data", "Upload business data");
      await navigate(
        page,
        "Evidence reports",
        "reports",
        "Evidence behind every decision.",
      );
      await navigate(page, "Billing", "billing", "Subscription and checkout");
      await navigate(page, "Activity", "activity", "Workspace activity");
      await expect(
        page.getByRole("heading", { name: "No customer activity yet." }),
      ).toBeVisible();
      await navigate(
        page,
        "Overview",
        "dashboard",
        "Your business, in perspective.",
      );
      for (const [path, heading] of [
        ["activity", "Workspace activity"],
        ["billing", "Subscription and checkout"],
        ["reports", "Evidence behind every decision."],
        ["data", "Upload business data"],
        ["business", "Business profile"],
        ["dashboard", "Your business, in perspective."],
      ]) {
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`#/${path}$`));
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
      }
      await page.goForward();
      await expect(page).toHaveURL(/#\/business$/);
      await expect(page.getByLabel("Industry", { exact: true })).toBeVisible();
    });

    test("retry recovers the requested workspace page after a network error", async ({
      page,
    }) => {
      await signIn(page);
      await page.route("**/api/dashboard", (route) => route.abort("failed"), {
        times: 1,
      });
      await page
        .getByRole("link", { name: "Data & uploads", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "We could not load your workspace.",
        }),
      ).toBeVisible();
      await expect(page).toHaveURL(/#\/data$/);
      await expect(
        page.getByRole("heading", { name: "Upload business data" }),
      ).toHaveCount(0);
      const recovered = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/dashboard") && response.ok(),
      );
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await recovered;
      await expect(
        page.getByRole("heading", { name: "Upload business data" }),
      ).toBeVisible();
      await expect(page).toHaveURL(/#\/data$/);
      await expect(
        page.getByRole("button", { name: "Try again", exact: true }),
      ).toHaveCount(0);
    });
  });
}

test("organization switching isolates uploads, validation, metrics and activity", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByLabel("Business", { exact: true })
    .selectOption({ label: "Acme Retail Group" });
  await expect(page.locator(".workspace-top")).toContainText(
    "Acme Retail Group",
  );
  await navigate(page, "Data & uploads", "data", "Upload business data");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "acme-navigation.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("product,revenue\nNavigation,1234.56\n"),
    });
  await page.getByLabel("Reporting month").fill("2026-01");
  await page.getByRole("button", { name: "Validate files" }).click();
  await expect(page.locator(".validation-summary")).toContainText("$1,234.56");
  await page
    .getByLabel("Business", { exact: true })
    .selectOption({ label: "Northstar Foods" });
  await expect(page.locator(".workspace-top")).toContainText("Northstar Foods");
  await expect(page.locator("#validation-result")).toBeEmpty();
  await expect(page.getByRole("main")).not.toContainText("acme-navigation.csv");
  await expect(
    page.getByText("No uploads yet.", { exact: false }),
  ).toBeVisible();
  await navigate(page, "Activity", "activity", "Workspace activity");
  await expect(page.getByRole("main")).not.toContainText("Data file validated");
  await navigate(
    page,
    "Overview",
    "dashboard",
    "Your business, in perspective.",
  );
  await expect(page.locator(".metrics-grid")).not.toContainText("$1,234.56");
  await expect(
    page.getByRole("heading", {
      name: "Your story starts with the first period.",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Business", { exact: true })
    .selectOption({ label: "Acme Retail Group" });
  await expect(page.locator(".workspace-top")).toContainText(
    "Acme Retail Group",
  );
  await navigate(page, "Data & uploads", "data", "Upload business data");
  await page
    .getByRole("row")
    .filter({ hasText: "acme-navigation.csv" })
    .getByRole("button", { name: "Review", exact: true })
    .click();
  await expect(page.locator(".validation-summary")).toContainText("$1,234.56");
  await page
    .getByRole("button", { name: "Confirm and add to dashboard" })
    .click();
  await expect(page.locator(".metrics-grid")).toContainText("$1,234.56");
  await page
    .getByLabel("Business", { exact: true })
    .selectOption({ label: "Northstar Foods" });
  await expect(page.locator(".workspace-top")).toContainText("Northstar Foods");
  await expect(page.locator(".metrics-grid")).not.toContainText("$1,234.56");
  await expect(page.getByRole("main")).not.toContainText("acme-navigation.csv");
  await page.reload();
  await expect(page.locator(".workspace-top")).toContainText("Northstar Foods");
  await expect(
    page.getByRole("heading", {
      name: "Your story starts with the first period.",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Business", { exact: true })
    .selectOption({ label: "Acme Retail Group" });
  await expect(page.locator(".workspace-top")).toContainText(
    "Acme Retail Group",
  );
  await expect(page.locator(".metrics-grid")).toContainText("$1,234.56");
  await expect(page.locator(".evidence-name")).toHaveText(
    "acme-navigation.csv",
  );
});
