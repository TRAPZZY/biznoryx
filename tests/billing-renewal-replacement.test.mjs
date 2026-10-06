import assert from "node:assert/strict";
import test from "node:test";

import { createProductionApp } from "../src/webapp/production-app.mjs";

test("cancelled Paystack subscription is replaced without charging the current paid period again", async () => {
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;

  const previousPlan = process.env.PAYSTACK_PLAN_CODE;

  process.env.PAYSTACK_SECRET_KEY = "sk_test_replacement";

  process.env.PAYSTACK_PLAN_CODE = "PLN_replacement";

  const providerCalls = [];

  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const subscription = {
    id: "subscription-old",

    organizationId: "org-1",

    provider: "paystack",

    providerCustomerCode: "CUS_existing",

    providerSubscriptionCode: "SUB_old",

    providerEmailToken: "old-token",

    planId: "biznoryx_monthly_ngn_40000",

    planName: "BIZNORYX Monthly",

    currency: "NGN",

    amountMinor: 4_000_000,

    interval: "monthly",

    status: "non_renewing",

    checkoutReference: "checkout-old",

    activeAt: new Date("2026-09-30T00:00:00.000Z"),

    currentPeriodEnd: periodEnd,
  };

  const billingRepository = {
    async ensureSubscription() {
      return subscription;
    },

    async renewSubscription(input) {
      assert.equal(input.providerSubscriptionCode, "SUB_replacement");

      assert.equal(input.providerEmailToken, "replacement-token");

      return {
        ...subscription,

        status: "active",

        providerSubscriptionCode: input.providerSubscriptionCode,

        providerEmailToken: input.providerEmailToken,

        cancellationRequestedAt: null,
      };
    },
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

    billingRepository,

    async paystackFetch(url, options) {
      const target = String(url);

      const body = options?.body ? JSON.parse(options.body) : null;

      providerCalls.push({
        target,
        method: options?.method,
        body,
      });

      if (target === "https://api.paystack.co/subscription/enable") {
        return Response.json(
          {
            status: false,

            message:
              "Subscription has been cancelled, and cannot be reactivated",
          },
          {
            status: 400,
          },
        );
      }

      if (
        target === "https://api.paystack.co/subscription" &&
        options?.method === "POST"
      ) {
        assert.equal(body.customer, "CUS_existing");

        assert.equal(body.plan, "PLN_replacement");

        assert.equal(body.start_date, periodEnd.toISOString());

        return Response.json({
          status: true,

          message: "Subscription successfully created",

          data: {
            subscription_code: "SUB_replacement",

            email_token: "replacement-token",

            status: "active",

            next_payment_date: periodEnd.toISOString(),
          },
        });
      }

      throw new Error("Unexpected Paystack request: " + target);
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

        "content-type": "application/json",
      },

      body: "{}",
    });

    const body = await response.json();

    assert.equal(response.status, 200);

    assert.equal(body.subscription.status, "active");

    assert.equal(body.subscription.currentPeriodEnd, periodEnd.toISOString());

    assert.equal(subscription.currentPeriodEnd, periodEnd);

    assert.equal(body.renewal.mode, "replacement_scheduled");

    assert.equal(body.renewal.nextPaymentDate, periodEnd.toISOString());

    assert.equal(providerCalls.length, 2);

    assert.equal(
      providerCalls[0].target,
      "https://api.paystack.co/subscription/enable",
    );

    assert.equal(
      providerCalls[1].target,
      "https://api.paystack.co/subscription",
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PAYSTACK_SECRET_KEY;
    } else {
      process.env.PAYSTACK_SECRET_KEY = previousSecret;
    }

    if (previousPlan === undefined) {
      delete process.env.PAYSTACK_PLAN_CODE;
    } else {
      process.env.PAYSTACK_PLAN_CODE = previousPlan;
    }

    server.closeAllConnections?.();

    await new Promise((resolve) => server.close(resolve));
  }
});
