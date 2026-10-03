import { test, expect } from "@playwright/test";

test("Help Center searches and filters troubleshooting articles", async ({
  page,
}) => {
  await page.route("https://downloads-global.3cx.com/**", async (route) => {
    await route.fulfill({
      status: 200,

      contentType: "text/javascript",

      body: "if (!customElements.get('call-us-selector')) customElements.define('call-us-selector', class extends HTMLElement {});",
    });
  });

  await page.goto("/help.html");

  await expect(
    page.getByRole("heading", {
      name: "How can we help?",
    }),
  ).toBeVisible();

  const search = page.getByPlaceholder("Search the Help Center...");

  /*
   * Search must support natural multi-word queries,
   * not only exact contiguous phrases.
   */
  await page
    .getByRole("button", {
      name: "Billing",
    })
    .click();

  await search.fill("upload rejected");

  const rejectedArticle = page.locator("details.article").filter({
    hasText: "Why was my upload rejected?",
  });

  await expect(rejectedArticle).toBeVisible();

  await expect(rejectedArticle).toHaveAttribute("open", "");

  await expect(
    rejectedArticle.getByText(/A file can be rejected/),
  ).toBeVisible();

  await expect(page.getByText("1 matching article")).toBeVisible();

  await search.fill("");

  await page
    .getByRole("button", {
      name: "Data & uploads",
    })
    .click();

  await expect(page.getByText("Why was my upload rejected?")).toBeVisible();

  await expect(
    page.getByText("How do I resume subscription renewal?"),
  ).toBeHidden();
});
