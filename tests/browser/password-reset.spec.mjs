import { test, expect } from "@playwright/test";

import { acceptRequiredPolicy } from "./helpers/policy-onboarding.mjs";

test("verified customer can recover access with a one-time code", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });

  const email = `recovery-${Date.now()}@example.com`;
  const originalPassword = "OriginalPassword2026!";
  const replacementPassword = "ReplacementPassword2026!";

  await page.goto("/#/register");
  await page.getByLabel("Full name").fill("Recovery Test Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(originalPassword);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email." }),
  ).toBeVisible();
  const verificationCode = await page
    .locator(".local-code strong")
    .textContent();
  await page.getByLabel("Verification code").fill(verificationCode.trim());
  await page.getByLabel("Choose account password").fill(originalPassword);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await acceptRequiredPolicy(page);

  const signOut = page.waitForResponse(
    (response) => response.url().endsWith("/api/sign-out") && response.ok(),
  );
  await page
    .getByRole("button", {
      name: "Open workspace menu",
    })
    .click();

  await page
    .locator("#workspace-sidebar")
    .getByRole("button", {
      name: "Sign out",
      exact: true,
    })
    .click();
  await signOut;

  await page.goto("/#/sign-in");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("heading", { name: "Reset your password." }),
  ).toBeVisible();
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: /Send reset code/ }).click();
  await expect(page.getByText("Local review code")).toBeVisible();
  const resetCode = await page
    .locator(".reset-code-preview strong")
    .textContent();

  await page
    .locator("#password-reset-confirm [name=code]")
    .fill(resetCode.trim());
  await page
    .locator("#password-reset-confirm [name=newPassword]")
    .fill(replacementPassword);
  await page.getByRole("button", { name: /Reset password/ }).click();
  await expect(
    page.getByRole("heading", { name: "Good to see you again." }),
  ).toBeVisible();

  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(replacementPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Make this workspace yours." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
