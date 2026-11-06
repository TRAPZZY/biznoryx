import assert from "node:assert/strict";
import test from "node:test";
import { mountTrialBilling } from "../web-app/trial-billing.js";

for (const status of ["active", "non_renewing", "trialing"]) {
  test(`${status} billing only loads trial availability when relevant`, async t => {
    const previous = globalThis.document;
    t.after(() => {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    });
    let created = 0;
    const calls = [];
    globalThis.document = {
      createElement() {
        created += 1;
        return { isConnected: false, setAttribute() {} };
      },
    };
    mountTrialBilling({
      container: { prepend() {}, querySelector() { return null; } },
      subscription: { status },
      async api(path) { calls.push(path); return { trial: {} }; },
    });
    await Promise.resolve();
    if (status === "trialing") {
      assert.equal(created, 1);
      assert.deepEqual(calls, ["billing/trial"]);
    } else {
      assert.equal(created, 0, "Paid billing must not mount a trial panel");
      assert.deepEqual(calls, [], "Paid billing must not depend on the trial service");
    }
  });
}
