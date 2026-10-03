import assert from "node:assert/strict";
import test from "node:test";

import { createProductionApp } from "../src/webapp/production-app.mjs";

test("non-renewing owner can resume Paystack subscription", async () => {
  const oldSecret = process.env.PAYSTACK_SECRET_KEY;

  const oldPlan = process.env.PAYSTACK_PLAN_CODE;

  process.env.PAYSTACK_SECRET_KEY = "sk_test_renew";

  process.env.PAYSTACK_PLAN_CODE = "PLN_renew";

  const calls = [];

  const subscription = {
    id: "subscription-1",
    organizationId: "org-1",
    provider: "paystack",
    providerSubscriptionCode: "SUB_renew",
    providerEmailToken: "email-token",
    planId: "biznoryx_monthly_ngn_40000",
    planName: "BIZNORYX Monthly",
    currency: "NGN",
    amountMinor: 4_000_000,
    interval: "monthly",
    status: "non_renewing",
    checkoutReference: "checkout-ref",
    activeAt: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  };

  const { server } = createProductionApp({
    identityRepository: {
      async authenticate({ token, csrfToken, requireCsrf }) {
        assert.equal(token, "renew-session");

        assert.equal(requireCsrf, true);

        assert.equal(csrfToken, "csrf-token");

        return {
          user: {
            id: "user-1",
            email: "owner@example.com",
          },

          session: {
            id: "session-1",
            activeOrganizationId: "org-1",
          },
        };
      },

      async activeMemberships() {
        return [
          {
            organizationId: "org-1",
            role: "owner",
          },
        ];
      },
    },

    emailVerificationRepository: {},

    billingRepository: {
      async ensureSubscription(input) {
        calls.push({
          operation: "ensure",
          input,
        });

        return subscription;
      },

      async renewSubscription(input) {
        calls.push({
          operation: "renew",
          input,
        });

        return {
          ...subscription,
          status: "active",

          cancellationRequestedAt: null,
        };
      },
    },

    async paystackFetch(url, options) {
      calls.push({
        operation: "paystack",

        url: String(url),

        body: JSON.parse(options.body),
      });

      return Response.json({
        status: true,

        message: "Subscription enabled successfully",
      });
    },

    production: false,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const base = "http://127.0.0.1:" + server.address().port;

  try {
    const response = await fetch(base + "/api/billing/renew", {
      method: "POST",

      headers: {
        cookie: "bnx_session=renew-session",

        "x-csrf-token": "csrf-token",
      },
    });

    const body = await response.json();

    assert.equal(response.status, 200);

    assert.equal(body.subscription.status, "active");

    assert.equal(calls[1].url, "https://api.paystack.co/subscription/enable");

    assert.deepEqual(calls[1].body, {
      code: "SUB_renew",

      token: "email-token",
    });

    assert.deepEqual(
      calls.map((call) => call.operation),
      ["ensure", "paystack", "renew"],
    );
  } finally {
    if (oldSecret === undefined) {
      delete process.env.PAYSTACK_SECRET_KEY;
    } else {
      process.env.PAYSTACK_SECRET_KEY = oldSecret;
    }

    if (oldPlan === undefined) {
      delete process.env.PAYSTACK_PLAN_CODE;
    } else {
      process.env.PAYSTACK_PLAN_CODE = oldPlan;
    }

    server.closeAllConnections?.();

    await new Promise((resolve) => server.close(resolve));
  }
});
