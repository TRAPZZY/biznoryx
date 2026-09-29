import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductionApp,
} from "../src/webapp/production-app.mjs";

test(
  "production onboarding writes the business profile to the authenticated active organization",
  async () => {
    const calls = [];

    const identityRepository =
      createIdentityRepository();

    const businessOnboardingRepository = {
      async upsertProfile(input) {
        calls.push(input);

        return {
          id: "profile-1",
          organizationId:
            input.organizationId,
          legalName:
            input.profile.legalName,
          tradingName:
            input.profile.tradingName ??
            null,
          industry:
            input.profile.industry,
          businessModel:
            input.profile.businessModel,
          primaryCurrency:
            input.profile.primaryCurrency,
          fiscalYearStartMonth:
            input.profile
              .fiscalYearStartMonth,
          timezone:
            input.profile.timezone,
          status: "draft",
          version: 1,
        };
      },

      async getProfile() {
        return null;
      },
    };

    const { server } =
      createProductionApp({
        identityRepository,

        emailVerificationRepository: {},

        businessOnboardingRepository,

        healthChecks:
          createHealthChecks(),

        production: false,
      });

    await listen(server);

    try {
      const response = await fetch(
        `${baseUrl(
          server,
        )}/api/onboarding/profile`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Cookie:
              "bnx_session=session-token",

            "X-CSRF-Token":
              "csrf-token",
          },

          body: JSON.stringify({
            legalName:
              "BIZNORYX Test Company",

            tradingName:
              "BIZNORYX",

            industry:
              "Business Intelligence",

            businessModel:
              "Subscription SaaS",

            primaryCurrency:
              "USD",

            fiscalYearStartMonth: 1,

            timezone: "UTC",
          }),
        },
      );

      const body =
        await response.json();

      assert.equal(
        response.status,
        200,
      );

      assert.equal(
        body.profile.organizationId,
        "org-1",
      );

      assert.equal(
        body.profile.legalName,
        "BIZNORYX Test Company",
      );

      assert.equal(
        calls.length,
        1,
      );

      assert.deepEqual(
        calls[0],
        {
          organizationId: "org-1",

          actorUserId: "user-1",

          profile: {
            legalName:
              "BIZNORYX Test Company",

            tradingName:
              "BIZNORYX",

            industry:
              "Business Intelligence",

            businessModel:
              "Subscription SaaS",

            primaryCurrency:
              "USD",

            fiscalYearStartMonth: 1,

            timezone: "UTC",
          },
        },
      );
    } finally {
      await close(server);
    }
  },
);

test(
  "production onboarding reads the business profile only from the authenticated active organization",
  async () => {
    const calls = [];

    const identityRepository =
      createIdentityRepository();

    const businessOnboardingRepository = {
      async upsertProfile() {
        throw new Error(
          "Unexpected profile write.",
        );
      },

      async getProfile(input) {
        calls.push(input);

        return {
          id: "profile-1",
          organizationId:
            input.organizationId,
          legalName:
            "Persistent Business",
          tradingName: null,
          industry: "Retail",
          businessModel:
            "Online sales",
          primaryCurrency: "USD",
          fiscalYearStartMonth: 1,
          timezone: "UTC",
          status: "draft",
          version: 1,
        };
      },
    };

    const { server } =
      createProductionApp({
        identityRepository,

        emailVerificationRepository: {},

        businessOnboardingRepository,

        healthChecks:
          createHealthChecks(),

        production: false,
      });

    await listen(server);

    try {
      const response = await fetch(
        `${baseUrl(
          server,
        )}/api/onboarding/profile`,
        {
          method: "GET",

          headers: {
            Cookie:
              "bnx_session=session-token",
          },
        },
      );

      const body =
        await response.json();

      assert.equal(
        response.status,
        200,
      );

      assert.equal(
        body.profile.organizationId,
        "org-1",
      );

      assert.equal(
        body.profile.legalName,
        "Persistent Business",
      );

      assert.deepEqual(
        calls,
        [
          {
            organizationId:
              "org-1",

            actorUserId:
              "user-1",
          },
        ],
      );
    } finally {
      await close(server);
    }
  },
);

function createIdentityRepository() {
  return {
    async authenticate({
      token,
      csrfToken,
      requireCsrf,
    }) {
      assert.equal(
        token,
        "session-token",
      );

      if (requireCsrf) {
        assert.equal(
          csrfToken,
          "csrf-token",
        );
      }

      return {
        user: {
          id: "user-1",
          email:
            "owner@example.com",
          displayName: "Owner",
          disabledAt: null,
        },

        session: {
          id: "session-1",
          userId: "user-1",
          activeOrganizationId:
            "org-1",
          expiresAt:
            new Date(
              Date.now() + 60_000,
            ),
        },
      };
    },
  };
}

function createHealthChecks() {
  return {
    liveness() {
      return {
        statusCode: 200,
        state: "alive",
      };
    },

    async readiness() {
      return {
        statusCode: 200,
        state: "ready",

        checks: {
          database: "healthy",
          objectStorage:
            "healthy",
          worker: "healthy",
        },
      };
    },
  };
}

async function listen(server) {
  await new Promise(
    (resolve, reject) => {
      server.once(
        "error",
        reject,
      );

      server.listen(
        0,
        "127.0.0.1",
        resolve,
      );
    },
  );
}

async function close(server) {
  await new Promise(
    (resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    },
  );
}

function baseUrl(server) {
  const address =
    server.address();

  if (
    !address ||
    typeof address === "string"
  ) {
    throw new Error(
      "Test server is not listening.",
    );
  }

  return `http://127.0.0.1:${address.port}`;
}