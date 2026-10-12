import { test as base, expect } from "@playwright/test";
import { createReviewApp } from "../../src/webapp/review-app.mjs";

const test = base.extend({
  membershipRole: ["owner", { option: true }],
  baseURL: async ({ membershipRole }, use) => {
    const { server, runtime } = createReviewApp();
    for (const membership of runtime.store.memberships.values())
      membership.role = membershipRole;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      await use(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});

for (const membershipRole of ["owner", "viewer"]) {
  test.describe(`${membershipRole} account access`, () => {
    test.use({ membershipRole });
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      test(`overview opens deletion instructions without changing account state at ${viewport.width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize(viewport);
        await page.goto("/#/sign-in");
        await page.getByLabel("Work email").fill("owner@biznoryx.local");
        await page
          .getByLabel("Password", { exact: true })
          .fill("ReviewPassphrase2026!");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(page.locator(".overview-v2")).toBeVisible();

        const link = page
          .locator(".overview-v2")
          .getByRole("link", { name: "Request account deletion", exact: true });
        await expect(link).toHaveAttribute("href", "/account-deletion.html");
        await link.scrollIntoViewIfNeeded();
        await expect(link).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath("overview-deletion-link.png"),
        });

        const writes = [];
        page.on("request", (request) => {
          if (!["GET", "HEAD"].includes(request.method()))
            writes.push(request.url());
        });
        await link.click();
        await expect(page).toHaveURL(/\/account-deletion\.html$/);
        await expect(
          page.getByRole("heading", {
            name: "Account deletion requests",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText(/does not itself delete an account/),
        ).toBeVisible();
        await expect(
          page.getByRole("link", {
            name: "BIZNORYX live support",
            exact: true,
          }),
        ).toHaveAttribute("href", "/help.html#live-support");
        expect(writes).toEqual([]);

        await page.goBack();
        await expect(page.locator(".overview-v2")).toBeVisible();
        await expect(link).toBeAttached();
        expect(writes).toEqual([]);
      });
    }
  });
}
