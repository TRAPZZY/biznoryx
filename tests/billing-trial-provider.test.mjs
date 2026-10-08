import assert from "node:assert/strict";
import test from "node:test";
import { TrialPaystackProvider } from "../src/billing/trial-provider.mjs";
import { TrialReminderEmailSender } from "../src/billing/trial-email-sender.mjs";

test("trial Paystack adapter accepts documented disable response without a data field", async () => {
  const provider = new TrialPaystackProvider({ env: { PAYSTACK_SECRET_KEY: "synthetic" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.paystack.co/subscription/disable");
      assert.deepEqual(JSON.parse(options.body), { code: "SUB_A", token: "synthetic-token" });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ status: true, message: "Subscription disabled successfully" });
    },
  });
  assert.deepEqual(await provider.disable("SUB_A", "synthetic-token"), {});
});

test("provider paginates official customer and transaction filters for recovery", async () => {
  const paths = [];
  const provider = new TrialPaystackProvider({ env: { PAYSTACK_SECRET_KEY: "synthetic" },
    fetchImpl: async (url) => {
      paths.push(new URL(url));
      const page = new URL(url).searchParams.get("page");
      return Response.json({ status: true, data: page === "1" ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] });
    },
  });
  assert.equal((await provider.listSubscriptions(51)).length, 101);
  assert.equal(paths[0].searchParams.get("customer"), "51");
  paths.length = 0;
  assert.equal((await provider.listRefunds(61)).length, 101);
  assert.equal(paths[0].searchParams.get("transaction"), "61");
});

test("trial email sender uses existing Resend transport settings and durable idempotency key", async () => {
  const sender = new TrialReminderEmailSender({ apiKey: "synthetic", from: "BIZNORYX <billing@example.com>",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.headers["Idempotency-Key"], "trial-reminder/trial-A");
      const body = JSON.parse(options.body);
      assert.equal(body.from, "BIZNORYX <billing@example.com>");
      assert.ok(body.text.includes("https://app.example.com/#/billing"));
      return Response.json({ id: "mail-A" });
    },
  });
  assert.deepEqual(await sender.sendTrialReminder({ to: "owner@example.com", trialId: "trial-A",
    endsAt: "2026-10-14T12:00:00Z", monthlyAmountMinor: 4_000_000, currency: "NGN",
    billingUrl: "https://app.example.com/#/billing" }), { provider: "resend", messageId: "mail-A" });
});
