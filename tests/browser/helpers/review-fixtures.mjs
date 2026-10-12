import { test as base } from "@playwright/test";
import { createReviewApp } from "../../../src/webapp/review-app.mjs";

// Each journey owns its state and auth quota without changing runtime limits.
export const test = base.extend({
  page: async ({ page }, use) => {
    // Remote font availability must not decide whether a local app journey
    // reaches its assertions. Native assets already use system fonts.
    await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
    await page.route("https://fonts.gstatic.com/**", route => route.abort());
    await use(page);
  },
  baseURL: async ({}, use) => {
    const { server } = createReviewApp();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      await use(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});

export { expect } from "@playwright/test";
