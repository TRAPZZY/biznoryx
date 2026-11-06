import assert from "node:assert/strict";
import test from "node:test";
import { availableFindings, actionTransitions, renderActionRows, actionPlansHtml } from "../web-app/action-plans.js";
import { canTransitionActionStatus } from "../src/database/business-actions-repository.mjs";

test("action plan transitions mirror the durable backend including terminal states", () => {
  const statuses = ["planned", "in_progress", "blocked", "completed", "cancelled"];
  for (const from of statuses) for (const to of statuses) {
    assert.equal(actionTransitions(from).includes(to), canTransitionActionStatus(from, to), `${from} -> ${to}`);
  }
  assert.deepEqual(actionTransitions("invalid"), []);
});

test("only active verified findings without an existing plan can be selected", () => {
  const one = { id: "a", status: "active", title: "Review sales" };
  assert.deepEqual(availableFindings({ signals: [one], risks: [one, { id: "b", status: "superseded" }] }), [one]);
  assert.deepEqual(availableFindings({ signals: [one], actions: [{ sourceFindingId: "a", status: "cancelled" }] }), []);
});

test("action rows escape source content and do not infer financial outcomes", () => {
  const actions = [{ id: 'id"', title: '<img src=x onerror="bad()">', status: "planned", dueDate: "2026-11-01", ownerUserId: "u",
    description: "Check stock\nSpeak to supplier", sourceFinding: { title: "<script>bad()</script>", summary: "A recorded signal" }, metric: { label: "Revenue" } }];
  const html = renderActionRows(actions, { canWrite: true, userId: "u" });
  assert.doesNotMatch(html, /<img|<script|net profit|caused|improved/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /Assigned to you/);
  assert.match(html, /2026-11-01/);
  assert.match(html, /select/);
  assert.doesNotMatch(renderActionRows(actions, { canWrite: false }), /<select|data-action-status/);
  assert.match(actionPlansHtml(), /Loading action plans/);
});
