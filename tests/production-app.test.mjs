import assert from "node:assert/strict";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

test("production authentication runtime registers, verifies, restores session and creates an organization", async () => {
  const state = {
    user: null,
    session: null,
    memberships: [],
  };

  const identityRepository = {
    async createUser({
      email,
      displayName,
    }) {
      state.user = {
        id: "user-1",
        email,
        displayName,
        disabledAt: null,
      };

      return state.user;
    },

    async createSessionForUser(user) {
      state.session = {
        id: "session-1",
        userId: user.id,
        activeOrganizationId: null,
      };

      return {
        user,
        session: state.session,
        memberships: [],
        token: "session-token",
        csrfToken: "csrf-token",
        cookie:
          "bnx_session=session-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800",
      };
    },

    async signIn() {
      return {
        user: state.user,
        session: state.session,
        memberships:
          state.memberships,
        token: "session-token",
        csrfToken: "csrf-token",
        cookie:
          "bnx_session=session-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800",
      };
    },

    async authenticate({
      token,
      csrfToken,
      requireCsrf,
    }) {
      if (
        token !==
        "session-token"
      ) {
        throw new AuthError(
          "Session is not active.",
          "SESSION_INVALID",
        );
      }

      if (
        requireCsrf &&
        ![
          "csrf-token",
          "csrf-rotated",
        ].includes(csrfToken)
      ) {
        throw new AuthError(
          "Invalid CSRF token.",
          "CSRF_INVALID",
        );
      }

      return {
        user: state.user,
        session: state.session,
      };
    },

    async rotateCsrfToken() {
      return "csrf-rotated";
    },

    async activeMemberships() {
      return state.memberships;
    },

    async createOrganization({
      name,
      slug,
    }) {
      const organization = {
        id: "org-1",
        name,
        slug,
      };

      state.memberships.push({
        id: "membership-1",
        organizationId:
          organization.id,
        organizationName:
          organization.name,
        organizationSlug:
          organization.slug,
        role: "owner",
      });

      return organization;
    },

    async switchOrganization({
      organizationId,
    }) {
      state.session = {
        ...state.session,
        activeOrganizationId:
          organizationId,
      };
    },

    async revokeSession() {
      state.session = null;
    },
  };

  const emailVerificationRepository = {
    async issue({ email }) {
      return {
        sent: true,
        email,
        expiresAt:
          new Date(
            Date.now() + 600_000,
          ),
        reviewCode:
          "12345678",
      };
    },

    async verify({
      email,
      code,
    }) {
      assert.equal(
        code,
        "12345678",
      );

      return {
        ...state.user,
        email,
        emailVerifiedAt:
          new Date(),
      };
    },
  };

  const healthChecks = {
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
        },
      };
    },
  };

  const { server } =
    createProductionApp({
      identityRepository,
      emailVerificationRepository,
      healthChecks,
      production: false,
    });

  await new Promise((resolve) =>
    server.listen(
      0,
      "127.0.0.1",
      resolve,
    ),
  );

  const base =
    `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(
      `${base}/healthz`,
    );

    assert.equal(
      health.status,
      200,
    );

    const registration =
      await fetch(
        `${base}/api/register`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            displayName:
              "Production Owner",

            email:
              "owner@example.com",

            password:
              "StrongPassword2026!",
          }),
        },
      );

    assert.equal(
      registration.status,
      201,
    );

    const registrationBody =
      await registration.json();

    assert.equal(
      registrationBody
        .requiresEmailVerification,
      true,
    );

    assert.equal(
        Object.hasOwn(
          registrationBody,
          "reviewCode",
        ),
        false,
    );

    const verification =
      await fetch(
        `${base}/api/auth/verify-email`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            email:
              "owner@example.com",
            code: "12345678",
          }),
        },
      );

    assert.equal(
      verification.status,
      200,
    );

    const verificationBody =
      await verification.json();

    assert.equal(
      verificationBody
        .authenticated,
      true,
    );

    assert.equal(
      verificationBody
        .shell.state,
      "empty",
    );

    const cookie =
      verification.headers
        .get("set-cookie")
        .split(";")[0];

    const restored = await fetch(
      `${base}/api/session`,
      {
        headers: {
          cookie,
        },
      },
    );

    assert.equal(
      restored.status,
      200,
    );

    const restoredBody =
      await restored.json();

    assert.equal(
      restoredBody.authenticated,
      true,
    );

    assert.equal(
      restoredBody.csrfToken,
      "csrf-rotated",
    );

    const organization =
      await fetch(
        `${base}/api/organizations`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",

            cookie,

            "x-csrf-token":
              restoredBody.csrfToken,
          },

          body: JSON.stringify({
            name:
              "Atlas Retail",
          }),
        },
      );

    assert.equal(
      organization.status,
      201,
    );

    const organizationBody =
      await organization.json();

    assert.equal(
      organizationBody
        .organization.name,
      "Atlas Retail",
    );

    assert.equal(
      organizationBody
        .shell.state,
      "ready",
    );

    assert.equal(
      organizationBody
        .shell.activeOrganization.id,
      "org-1",
    );
  } finally {
    await new Promise((resolve) =>
      server.close(resolve),
    );
  }
});

test("production readiness checks database, object storage, and worker by default", async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push("database");
      assert.equal(String(sql), "select 1");
      return { rows: [{ result: 1 }] };
    },
  };
  const objectStorage = {
    async healthCheck() {
      calls.push("objectStorage");
      return true;
    },
  };
  const processingJobRepository = {
    async hasHealthyWorker({ maxAgeSeconds }) {
      calls.push("worker");
      assert.equal(maxAgeSeconds, 30);
      return true;
    },
  };

  const { server } = createProductionApp({
    pool,
    objectStorage,
    processingJobRepository,
    production: false,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${base}/readyz`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "ready");
    assert.deepEqual(body.checks, {
      database: "healthy",
      objectStorage: "healthy",
      worker: "healthy",
    });
    assert.deepEqual(calls.sort(), ["database", "objectStorage", "worker"]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("password reset requests have one public response and confirm consumes through the repository", async () => {
  const calls = [];
  const { server } = createProductionApp({
    identityRepository: {},
    emailVerificationRepository: {
      async issue(input) {
        calls.push({ operation: "issue", input });
        return { sent: true, email: input.email, expiresAt: new Date() };
      },
      async resetPassword(input) {
        calls.push({ operation: "reset", input });
        return { reset: true };
      },
    },
    production: false,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const requestReset = (email) => fetch(
      `${base}/api/auth/password-reset/request`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    );

    const [known, unknown] = await Promise.all([
      requestReset("known@example.com"),
      requestReset("unknown@example.com"),
    ]);

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.equal(calls[0].input.purpose, "password_reset");
    assert.equal(calls[1].input.purpose, "password_reset");

    const confirmation = await fetch(
      `${base}/api/auth/password-reset/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "known@example.com",
          code: "12345678",
          newPassword: "A-New-Long-Password-2026!",
        }),
      },
    );

    assert.equal(confirmation.status, 200);
    assert.equal((await confirmation.json()).reset, true);
    assert.deepEqual(calls[2], {
      operation: "reset",
      input: {
        email: "known@example.com",
        code: "12345678",
        newPassword: "A-New-Long-Password-2026!",
      },
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});