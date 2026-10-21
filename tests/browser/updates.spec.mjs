import { test as base, expect } from "@playwright/test";
import { createReviewApp, createReviewRuntime } from "../../src/webapp/review-app.mjs";

const test = base.extend({
  baseURL: async ({}, use) => {
    const runtime = createReviewRuntime();
    const business = runtime.seededOrganizations[0];
    const items = [
      { id: "11111111-1111-4111-8111-111111111111", kind: "report_ready", category: "reports", title: "Your data is ready", message: "Source checks and calculations are complete. Review the evidence for this period.", evidenceStatus: "current", period: "October 2026", createdAt: "2026-10-20T09:00:00Z", readAt: null },
      { id: "22222222-2222-4222-8222-222222222222", kind: "upload_attention", category: "data", title: "A file needs your review", message: "Review the issues before using this file in your business history.", evidenceStatus: "superseded", period: "September 2026", createdAt: "2026-10-19T09:00:00Z", readAt: null },
    ].map(item => ({ ...item, href: `#/data?upload=${item.id}`, actionLabel: "Review source" }));
    const preferences = { reports: true, data: true };
    runtime.updates = {
      async list({ organizationId, filter = "all", category = "all", offset = 0, limit = 25 }) {
        if (organizationId !== business) return { enabled: false, items: [], unreadCount: 0 };
        const filtered = items.filter(x => (category === "all" || category === x.category) &&
          (filter === "all" || (filter === "unread" && !x.readAt && !x.snoozedUntil) || (filter === "snoozed" && x.snoozedUntil)));
        return { enabled: true, items: filtered.slice(offset, offset + limit), hasMore: false,
          unreadCount: items.filter(x => !x.readAt && !x.snoozedUntil).length, snapshotAt: new Date().toISOString(), preferences };
      },
      async setState({ change }) {
        const item = items.find(x => x.id === change.id);
        if (change.action === "snooze") item.snoozedUntil = change.until;
        else item.readAt = change.action === "read" ? new Date().toISOString() : null;
        return { saved: true };
      },
      async markAllRead() { items.forEach(x => { x.readAt = new Date().toISOString(); }); return { saved: true }; },
      async setPreference({ preference }) { preferences[preference.category] = preference.enabled; return { saved: true }; },
    };
    const { server } = createReviewApp(runtime);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
});

async function signIn(page) {
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#workspace-sidebar")).toBeAttached();
}

for (const width of [1440, 390]) {
  test(`Updates bell, read states, snooze and preferences at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await signIn(page);
    const bell = page.getByRole("button", { name: "Updates, 2 unread", exact: true });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByRole("region", { name: "Recent updates" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bell).toBeFocused();
    await expect(page.locator("#updates-panel")).toBeHidden();
    await page.goto("/#/updates");
    await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
    await expect(page.locator(".updates-list .update-row")).toHaveCount(2);
    await page.getByRole("button", { name: "Mark read: Your data is ready", exact: true }).click();
    await expect(page.getByRole("button", { name: "Mark unread: Your data is ready", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("unread");
    await expect(page.locator(".updates-list .update-row")).toHaveCount(1);
    await expect(page.locator(".updates-list")).toContainText("Replaced by newer evidence");
    await page.getByLabel("Remind me: A file needs your review", { exact: true }).last().selectOption("24");
    await expect(page.getByText("No updates in this view.")).toBeVisible();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("snoozed");
    await expect(page.locator(".updates-list .update-row")).toHaveCount(1);
    await page.getByLabel("Remind me: A file needs your review", { exact: true }).last().selectOption("0");
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("all");
    await page.getByText("Notification preferences", { exact: true }).click();
    await page.getByLabel("Reports ready", { exact: true }).uncheck();
    await expect(page.getByLabel("Reports ready", { exact: true })).not.toBeChecked();
    await expect(page.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`updates-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    await page.locator("#org-switch").selectOption({ label: "Northstar Foods" });
    await expect(page.getByText("Updates are not enabled for this business.")).toBeVisible();
    await expect(page.locator("[data-updates-nav]")).toBeHidden();
    await expect(page.locator("#updates-control")).toBeHidden();
    await expect(page.locator(".updates-list .update-row")).toHaveCount(0);
  });
}

test("Updates failure retains truthful error and supports retry", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/updates?*", route => route.fulfill({ status: 503, json: { message: "Updates are temporarily unavailable. Retry." } }));
  await page.goto("/#/updates");
  await expect(page.locator("#updates-message")).toContainText("temporarily unavailable");
  await expect(page.getByText("No updates in this view.")).toHaveCount(0);
  await page.unroute("**/api/updates?*");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".updates-list .update-row")).toHaveCount(2);
});
