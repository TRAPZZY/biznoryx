import assert from "node:assert/strict";
import test from "node:test";

import { createProductionApp } from "../src/webapp/production-app.mjs";

for (const recoverToken of [false, true]) {
  test(`non-renewing owner can resume Paystack subscription${recoverToken ? " using the persisted identity to recover its token" : ""}`, async () => {
    const oldSecret = process.env.PAYSTACK_SECRET_KEY;

    const oldPlan = process.env.PAYSTACK_PLAN_CODE;

    process.env.PAYSTACK_SECRET_KEY = "sk_test_renew";

    process.env.PAYSTACK_PLAN_CODE = "PLN_renew";

    const calls = [];

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const subscription = {
      id: "subscription-1",
      organizationId: "org-1",
      provider: "paystack",
      providerSubscriptionCode: "SUB_renew",
      providerEmailToken: recoverToken ? null : "email-token",
      planId: "biznoryx_monthly_ngn_40000",
      planName: "BIZNORYX Monthly",
      currency: "NGN",
      amountMinor: 4_000_000,
      interval: "monthly",
      status: "non_renewing",
      checkoutReference: "checkout-ref",
      activeAt: new Date("2026-10-01T00:00:00.000Z"),
      currentPeriodEnd: periodEnd,
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

          body: options.body ? JSON.parse(options.body) : null,
        });

        if (String(url) === "https://api.paystack.co/subscription/SUB_renew") {
          assert.equal(options.method, "GET");
          return Response.json({
            status: true,
            data: {
              subscription_code: "SUB_renew",
              email_token: "email-token",
              status: "non-renewing",
            },
          });
        }

        assert.equal(
          String(url),
          "https://api.paystack.co/subscription/enable",
        );
        assert.equal(options.method, "POST");

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

      assert.equal(body.subscription.currentPeriodEnd, periodEnd.toISOString());
      assert.equal(subscription.currentPeriodEnd, periodEnd);

      const enableCall = calls[recoverToken ? 2 : 1];
      assert.equal(
        enableCall.url,
        "https://api.paystack.co/subscription/enable",
      );

      assert.deepEqual(enableCall.body, {
        code: "SUB_renew",

        token: "email-token",
      });

      assert.deepEqual(
        calls.map((call) => call.operation),
        recoverToken
          ? ["ensure", "paystack", "paystack", "renew"]
          : ["ensure", "paystack", "renew"],
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
}
