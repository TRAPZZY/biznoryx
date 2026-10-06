import { test, expect } from "@playwright/test";

import { acceptRequiredPolicy } from "./helpers/policy-onboarding.mjs";

test("verified users must accept account and data onboarding before workspace access", async ({
  page,
}) => {
  await page.goto("/#/register");

  await page.getByLabel("Full name").fill("Policy Review User");

  await page.getByLabel("Work email").fill("policy-review@example.com");

  await page
    .getByLabel("Password", {
      exact: true,
    })
    .fill("PolicyReviewPassword2026!");

  await page
    .getByRole("button", {
      name: "Create account",
    })
    .click();

  await expect(
    page.getByRole("heading", {
      name: "Check your email.",
    }),
  ).toBeVisible();

  const code = await page.locator(".local-code strong").textContent();

  await page.getByLabel("Verification code").fill(code.trim());
  await page.getByLabel("Choose account password").fill("PolicyReviewPassword2026!");

  await page
    .getByRole("button", {
      name: "Verify and continue",
    })
    .click();

  await expect(
    page.getByRole("heading", {
      name: "Before you bring business data into BIZNORYX.",
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    location.hash = "/business";
  });

  await expect(
    page.getByRole("heading", {
      name: "Before you bring business data into BIZNORYX.",
    }),
  ).toBeVisible();

  await acceptRequiredPolicy(page);

  await expect(
    page.getByRole("heading", {
      name: "Make this workspace yours.",
    }),
  ).toBeVisible();

  await page.reload();

  await expect(
    page.getByRole("heading", {
      name: "Make this workspace yours.",
    }),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", {
      name: "Before you bring business data into BIZNORYX.",
    }),
  ).toHaveCount(0);
});
