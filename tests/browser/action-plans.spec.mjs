import { test, expect } from "@playwright/test";

// Synthetic HTTP contracts exercise the UI only. PostgreSQL authorization and
// persistence are independently exercised by postgres-business-actions.test.mjs.
async function openPlans(page, { role = "owner", failSave = false, unavailable = false } = {}) {
  const actions = [];
  const writes = [];
  const finding = { id: "synthetic-finding", status: "active", title: "Review revenue changes", summary: "Revenue rose 25% between two verified periods." };
  let actor, organizationId;
  await page.route("**/api/dashboard", async route => {
    const response = await route.fetch();
    const data = await response.json();
    actor = data.shell.user;
    organizationId = data.shell.activeOrganization.id;
    data.shell.organizations = data.shell.organizations.map(item => ({ ...item, role }));
    if (!unavailable) Object.assign(data, { actions, signals: [], risks: [], opportunities: [{ ...finding, status: actions.length ? "accepted" : "active" }], focusAreas: [] });
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/actions", async route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (failSave) return route.fulfill({ status: 503, json: { message: "Action service temporarily unavailable." } });
    const action = { id: "synthetic-action", organizationId, sourceFindingId: finding.id, title: body.title, description: body.description, dueDate: body.dueDate,
      ownerUserId: actor.id, status: "planned", sourceFinding: finding, metric: { label: "Revenue" }, reportingPeriod: { label: "February 2026" } };
    actions.push(action);
    await route.fulfill({ status: 201, json: { action } });
  });
  await page.route("**/api/actions/*/status", async route => {
    expect(route.request().method()).toBe("PATCH");
    const body = route.request().postDataJSON();
    writes.push(body);
    actions[0].status = body.status;
    await route.fulfill({ json: { action: actions[0] } });
  });
  await page.goto("/#/sign-in");
  await page.getByLabel("Work email").fill("owner@biznoryx.local");
  await page.getByLabel("Password", { exact: true }).fill("ReviewPassphrase2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#workspace-sidebar")).toBeAttached();
  await page.goto("/#/actions");
  await expect(page.getByRole("heading", { name: "Action plans", exact: true })).toBeVisible();
  return { actions, writes, finding };
}

for (const width of [1440, 390]) {
  test(`Action plans create, source evidence, filter and status at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const state = await openPlans(page);
    await expect(page.getByText("No action plans yet.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New action", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Action title", { exact: true }).fill("Review <script> sales drivers");
    await page.getByLabel("Steps and resources").fill("Compare product mix; review with the sales team.");
    await page.getByLabel("Due date", { exact: true }).fill("2026-11-01");
    await page.screenshot({ path: info.outputPath(`action-plan-form-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(page.locator(".action-plans-message")).toHaveText("Action saved.");
    await expect(page.locator(".action-plan-row")).toHaveCount(1);
    await expect(page.locator(".action-plan-row h2")).toHaveText("Review <script> sales drivers");
    await expect(page.locator(".action-plan-row script")).toHaveCount(0);
    expect(state.writes[0]).toEqual({ findingId: state.finding.id, title: "Review <script> sales drivers", description: "Compare product mix; review with the sales team.", dueDate: "2026-11-01" });
    await expect(page.getByRole("button", { name: "New action", exact: true })).toBeDisabled();
    await page.getByText("Source finding", { exact: true }).click();
    await expect(page.locator(".action-plan-evidence").getByText(state.finding.summary, { exact: true })).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("not present");
    await expect(page.getByText("No actions match these filters.")).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("");
    const status = page.getByRole("combobox", { name: "Status: Review <script> sales drivers", exact: true });
    await status.selectOption("in_progress");
    await expect(page.locator(".action-plans-message")).toHaveText("Action status saved.");
    await expect(status).toHaveValue("in_progress");
    await status.selectOption("blocked");
    await expect(status).toHaveValue("blocked");
    await expect(page.locator(".action-plans-message")).toHaveText("Action status saved.");
    await status.selectOption("in_progress");
    await expect(page.locator(".action-plans-message")).toHaveText("Action status saved.");
    await status.selectOption("completed");
    await expect(page.locator(".action-plan-state")).toHaveText("Completed");
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("planned");
    await expect(page.getByText("No actions match these filters.")).toBeVisible();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("all");
    await page.screenshot({ path: info.outputPath(`action-plans-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("Action plans viewer cannot create or change status", async ({ page }) => {
  const state = await openPlans(page, { role: "viewer" });
  state.actions.push({ id: "viewer-action", title: "Owner action", status: "planned", sourceFindingId: state.finding.id, sourceFinding: state.finding });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".action-plans-message")).toHaveText("Action plans refreshed.");
  await expect(page.locator(".action-plan-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New action", exact: true })).toBeHidden();
  await expect(page.locator("[data-action-status]")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("Action save failure retains input and refresh recovers a loading error", async ({ page }) => {
  const state = await openPlans(page, { failSave: true });
  await page.getByRole("button", { name: "New action", exact: true }).click();
  await page.getByLabel("Action title", { exact: true }).fill("Keep this action");
  await page.getByRole("button", { name: "Save action", exact: true }).click();
  await expect(page.locator(".action-plan-form-message")).toContainText("temporarily unavailable");
  await expect(page.getByLabel("Action title", { exact: true })).toHaveValue("Keep this action");
  await expect(page.getByRole("button", { name: "Save action", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.route("**/api/dashboard", route => route.fulfill({ status: 503, json: { message: "Try again shortly." } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".action-plans-message")).toHaveText("Try again shortly.");
  await page.unroute("**/api/dashboard");
  // Restore a real route response without action support: never fake success.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".action-plans-message")).toHaveText("Action plans are unavailable in this environment.");
});

test("Action plans unavailable backend is not presented as an empty working feature", async ({ page }) => {
  await openPlans(page, { unavailable: true });
  await expect(page.locator(".action-plans-message")).toHaveText("Action plans are unavailable in this environment.");
  await expect(page.getByText("No action plans yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New action", exact: true })).toBeHidden();
});
