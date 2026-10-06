import { test, expect } from "@playwright/test";

import { acceptRequiredPolicy } from "./helpers/policy-onboarding.mjs";

async function openWorkspaceMenuIfNeeded(page) {
  const toggle = page.getByRole("button", {
    name: "Open workspace menu",
  });

  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  }
}

async function clickWorkspaceLink(page, name) {
  await openWorkspaceMenuIfNeeded(page);

  await page
    .locator("#workspace-sidebar")
    .getByRole("link", {
      name,
      exact: true,
    })
    .click();
}

async function signOutWorkspace(page) {
  const toggle = page.getByRole("button", {
    name: "Open workspace menu",
  });

  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();

    await page
      .locator("#workspace-sidebar")
      .getByRole("button", {
        name: "Sign out",
        exact: true,
      })
      .click();

    return;
  }

  await page
    .getByRole("banner")
    .getByRole("button", {
      name: "Sign out",
      exact: true,
    })
    .click();
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`customer journey at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);

    const errors = [];

    page.on("pageerror", (error) => {
      errors.push(error.message);
    });

    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "BIZNORYX", exact: true }),
    ).toBeVisible();

    await expect
      .poll(() =>
        page
          .locator(".hero-image")
          .evaluate((img) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);

    await page.screenshot({
      path: testInfo.outputPath("landing.png"),
      fullPage: true,
    });

    await page.getByRole("link", { name: "Get started" }).click();

    await page.getByLabel("Full name").fill("Browser Test Owner");

    await page
      .getByLabel("Work email")
      .fill(`browser-${viewport.width}-${Date.now()}@example.com`);

    await page
      .getByLabel("Password", { exact: true })
      .fill("BrowserTestPassword2026!");

    await page.screenshot({
      path: testInfo.outputPath("registration.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByRole("heading", { name: "Check your email." }),
    ).toBeVisible();

    const code = await page.locator(".local-code strong").textContent();

    await page.getByLabel("Verification code").fill(code.trim());
    await page.getByLabel("Choose account password").fill("BrowserTestPassword2026!");

    await page.getByRole("button", { name: "Verify and continue" }).click();
    await acceptRequiredPolicy(page);

    await expect(
      page.getByRole("heading", {
        name: "Make this workspace yours.",
      }),
    ).toBeVisible();

    await page.getByLabel("Business name").fill("Atlas Retail");

    await page.getByLabel("Industry", { exact: true }).fill("Retail");

    await page
      .getByLabel("Business model", { exact: true })
      .fill("Product sales");

    await page.screenshot({
      path: testInfo.outputPath("onboarding.png"),
      fullPage: true,
    });

    await page
      .getByRole("button", {
        name: "Create business",
        exact: true,
      })
      .click();

    await expect(
      page.getByRole("heading", {
        name: "Upload business data",
      }),
    ).toBeVisible();

    await page.locator("input[type=file]").setInputFiles({
      name: "sales.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("product,revenue\nA,1250.10\nB,750.20\n"),
    });

    await page.getByRole("button", { name: "Validate files" }).click();

    await expect(
      page.getByRole("heading", {
        name: "Your data is ready to review.",
      }),
    ).toBeVisible();

    await expect(page.locator(".validation-summary")).toContainText(
      "$2,000.30",
    );

    await page.screenshot({
      path: testInfo.outputPath("validation.png"),
      fullPage: true,
    });

    await page
      .getByRole("button", {
        name: "Confirm and add to dashboard",
      })
      .click();

    await expect(page.locator(".overview-v2-stats")).toContainText(
      "No verified period",
    );
    await expect(page.locator(".overview-v2-stats")).toContainText(
      "Source-backed reports ready",
    );

    await clickWorkspaceLink(page, "Evidence reports");

    await expect(
      page.getByRole("heading", {
        name: "Evidence behind every decision.",
      }),
    ).toBeVisible();

    await expect(page.getByRole("main")).toContainText("sum(revenue)");
    await expect(page.getByRole("main")).toContainText("VERIFIED FACT");

    await clickWorkspaceLink(page, "Overview");

    await page.reload();

    await expect(page.locator(".overview-v2-stats")).toContainText(
      "No verified period",
    );

    await page.screenshot({
      path: testInfo.outputPath("dashboard.png"),
      fullPage: true,
    });

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await clickWorkspaceLink(page, "Data & uploads");

    await page.locator("input[type=file]").setInputFiles({
      name: "invalid.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("revenue\nnot-money\n"),
    });

    await page.getByRole("button", { name: "Validate files" }).click();

    await expect(
      page.getByRole("heading", {
        name: "A few things need attention.",
      }),
    ).toBeVisible();

    await expect(
      page.getByRole("button", {
        name: "Confirm and add to dashboard",
      }),
    ).toHaveCount(0);

    await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith("/api/sign-out") && response.ok(),
      ),

      signOutWorkspace(page),
    ]);

    await expect(
      page.getByRole("heading", {
        name: "BIZNORYX",
        exact: true,
      }),
    ).toBeVisible();

    await page.goto("/#/dashboard");

    await expect(
      page.getByRole("heading", {
        name: "Good to see you again.",
      }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
}
