import { test, expect } from "@playwright/test";

test.use({
  viewport: {
    width: 390,
    height: 844,
  },
});

test("mobile workspace navigation is compact, expandable and has one visible sign out", async ({
  page,
}) => {
  await page.goto("/#/sign-in");

  await page.getByLabel("Work email").fill("owner@biznoryx.local");

  await page
    .getByLabel("Password", {
      exact: true,
    })
    .fill("ReviewPassphrase2026!");

  await page
    .getByRole("button", {
      name: "Sign in",
      exact: true,
    })
    .click();

  await expect(page.locator(".overview-v2")).toBeVisible();

  const sidebar = page.locator("#workspace-sidebar");

  let toggle = sidebar.locator("#sidebar-toggle");

  await expect(toggle).toBeVisible();

  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await expect(sidebar.locator("nav")).toBeHidden();

  await expect(sidebar.locator(".sidebar-bottom")).toBeHidden();

  await expect(page.locator(".workspace-top .top-sign-out")).toBeHidden();

  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await expect(toggle).toHaveAttribute("aria-label", "Close workspace menu");

  await expect(sidebar.locator("nav")).toBeVisible();

  await expect(
    sidebar.getByRole("link", {
      name: "Help & support",
    }),
  ).toBeVisible();

  await expect(
    sidebar.getByRole("button", {
      name: "Sign out",
      exact: true,
    }),
  ).toBeVisible();

  await expect(page.locator(".workspace-top .top-sign-out")).toBeHidden();

  await sidebar
    .getByRole("link", {
      name: "Data & uploads",
      exact: true,
    })
    .click();

  await expect(page).toHaveURL(/#\/data$/);

  toggle = page.getByRole("button", {
    name: "Open workspace menu",
  });

  await expect(toggle).toBeVisible();

  await expect(page.locator("#workspace-sidebar nav")).toBeHidden();

  const size = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,

    viewport: window.innerWidth,
  }));

  expect(size.page).toBeLessThanOrEqual(size.viewport + 1);
});
