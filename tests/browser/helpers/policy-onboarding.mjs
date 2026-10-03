import { expect } from "@playwright/test";

export async function acceptRequiredPolicy(page) {
  await expect(
    page.getByRole("heading", {
      name: "Before you bring business data into BIZNORYX.",
    }),
  ).toBeVisible();

  await page.getByLabel("I agree to the BIZNORYX Terms of Use.").check();

  await page.getByLabel("I have read the Data & Privacy Notice.").check();

  await page
    .getByLabel(
      "I confirm I am authorized to upload and process the data I submit.",
    )
    .check();

  await page
    .getByRole("button", {
      name: "Continue to data guide",
    })
    .click();

  await expect(
    page.getByRole("heading", {
      name: "Build one reliable history at a time.",
    }),
  ).toBeVisible();

  await expect(
    page.getByText("Transaction History", {
      exact: true,
    }),
  ).toBeVisible();

  await expect(
    page.getByText("Current production intake: CSV", {
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByLabel(
      "I understand that each recurring data series should keep a stable structure across reporting periods.",
    )
    .check();

  await page
    .getByRole("button", {
      name: "Finish setup",
    })
    .click();
}
