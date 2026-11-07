import { test, expect } from "@playwright/test";

async function signIn(page) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page
    .getByLabel("Password", { exact: true })
    .fill("ReviewPassphrase2026!");
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator(".overview-v2")).toBeVisible();
}

async function assertSidebarIdentity(page) {
  expect(
    await page.evaluate(
      () => document.querySelector("#workspace-sidebar") ===
        window.__originalSidebar,
    ),
  ).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`persistent workspace sidebar at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("preserves the sidebar across Overview and Data & uploads navigation", async ({
      page,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await signIn(page);

      await page.evaluate(() => {
        window.__originalSidebar = document.querySelector("#workspace-sidebar");
      });

      if (viewport.width > 700) {
        const collapse = page.getByRole("button", {
          name: "Collapse sidebar",
        });
        await collapse.click();
        await expect(page.locator(".workspace")).toHaveClass(
          /sidebar-collapsed/,
        );
      } else {
        await page
          .getByRole("button", { name: "Open workspace menu" })
          .click();
        await expect(
          page.getByRole("button", { name: "Close workspace menu" }),
        ).toHaveAttribute("aria-expanded", "true");
      }

      await page
        .locator("#workspace-sidebar")
        .getByRole("link", { name: "Data & uploads", exact: true })
        .click();

      await expect(
        page.getByRole("heading", { name: "Upload business data" }),
      ).toBeVisible();

      await assertSidebarIdentity(page);

      await expect(
        page.locator('#workspace-sidebar a[href="#/data"]'),
      ).toHaveAttribute("aria-current", "page");

      if (viewport.width > 700) {
        await expect(page.locator(".workspace")).toHaveClass(
          /sidebar-collapsed/,
        );
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await expect(page.locator(".workspace")).not.toHaveClass(
          /sidebar-collapsed/,
        );
      } else {
        await expect(
          page.getByRole("button", { name: "Open workspace menu" }),
        ).toHaveAttribute("aria-expanded", "false");
        await page
          .getByRole("button", { name: "Open workspace menu" })
          .click();
      }

      await page
        .locator("#workspace-sidebar")
        .getByRole("link", { name: "Overview", exact: true })
        .click();

      await expect(page.locator(".overview-v2")).toBeVisible();
      await assertSidebarIdentity(page);

      await expect(
        page.locator('#workspace-sidebar a[href="#/dashboard"]'),
      ).toHaveAttribute("aria-current", "page");

      if (viewport.width <= 700) {
        await expect(
          page.getByRole("button", { name: "Open workspace menu" }),
        ).toHaveAttribute("aria-expanded", "false");
      }

      expect(errors).toEqual([]);
    });
  });
}
