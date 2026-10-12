import { test, expect } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`landing and public-page footers link to privacy at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    for (const path of ["/", "/#/product", "/#/pricing", "/#/security", "/#/solutions", "/#/resources"]) {
      await page.goto(path);
      const footer = page.getByRole("contentinfo");
      const privacy = footer.getByRole("link", { name: "Privacy Policy", exact: true });
      await expect(privacy).toHaveAttribute("href", "/privacy.html");
      await expect(footer.getByRole("link", { name: "Data deletion", exact: true })).toHaveAttribute("href", "/delete-data");
      await privacy.scrollIntoViewIfNeeded();
      await expect(privacy).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === "/") await page.screenshot({ path: testInfo.outputPath("landing-footer.png") });
      await privacy.click();
      await expect(page).toHaveURL(/\/privacy\.html$/);
      await expect(page.getByRole("heading", { name: "BIZNORYX Privacy Policy", exact: true })).toBeVisible();
    }
  });

  test(`public privacy resources are readable at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));

    await page.goto("/privacy.html");
    await expect(page.getByRole("heading", { name: "BIZNORYX Privacy Policy", exact: true })).toBeVisible();
    await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("href", "/privacy.css");
    expect(await page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily)).toContain("Arial");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("privacy-viewport.png") });
    await page.getByRole("navigation").getByRole("link", { name: "Retention", exact: true }).click();
    await expect(page.getByRole("heading", { name: "8. Retention and its limits", exact: true })).toBeInViewport();
    await page.getByRole("banner").getByRole("link", { name: "Privacy contact" }).click();
    await expect(page.getByRole("heading", { name: "13. Privacy contact", exact: true })).toBeInViewport();

    await page.getByRole("contentinfo").getByRole("link", { name: "Account deletion requests" }).click();
    await expect(page).toHaveURL(/\/account-deletion\.html$/);
    await expect(page.getByRole("heading", { name: "Account deletion requests", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("deletion-viewport.png") });
    await page.getByRole("link", { name: "BIZNORYX data deletion requests", exact: true }).click();
    await expect(page).toHaveURL(/\/delete-data$/);
    await expect(page.getByRole("heading", { name: "BIZNORYX Data Deletion Requests", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Contact BIZNORYX support to request data deletion", exact: true })).toHaveAttribute("href", "/help.html#live-support");
    await expect(page.getByText(/without deleting your account/)).toBeVisible();
    await expect(page.getByText(/does not submit a request or delete/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("data-deletion-viewport.png"), fullPage: true });
    await page.goto("/delete-data/");
    await expect(page.getByRole("heading", { name: "BIZNORYX Data Deletion Requests", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(requests.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    expect(requests.some((url) => new URL(url).pathname.startsWith("/api/"))).toBe(false);
  });
}
