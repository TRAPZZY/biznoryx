import assert from "node:assert/strict";
import test from "node:test";

import { postgresAppShellState } from "../src/server/postgres-app-shell.mjs";

test("PostgreSQL app shell returns empty state when user has no organization", async () => {
  const user = {
    id: "user-1",
    email: "owner@example.com",
    displayName: "Owner",
    disabledAt: null,
  };

  const session = {
    id: "session-1",
    userId: user.id,
    activeOrganizationId: null,
  };

  const identityRepository = {
    async activeMemberships() {
      return [];
    },
  };

  const shell =
    await postgresAppShellState({
      user,
      session,
      identityRepository,
    });

  assert.equal(shell.state, "empty");

  assert.equal(
    shell.primaryAction,
    "create-organization",
  );

  assert.equal(
    shell.user.email,
    "owner@example.com",
  );

  assert.deepEqual(
    shell.organizations,
    [],
  );

  assert.equal(
    shell.activeOrganization,
    null,
  );
});

test("PostgreSQL app shell returns the active organization", async () => {
  const user = {
    id: "user-1",
    email: "owner@example.com",
    displayName: "Owner",
    disabledAt: null,
  };

  const session = {
    id: "session-1",
    userId: user.id,
    activeOrganizationId: "org-2",
  };

  const identityRepository = {
    async activeMemberships() {
      return [
        {
          id: "membership-1",
          organizationId: "org-1",
          organizationName:
            "First Company",
          organizationSlug:
            "first-company",
          role: "owner",
        },
        {
          id: "membership-2",
          organizationId: "org-2",
          organizationName:
            "Second Company",
          organizationSlug:
            "second-company",
          role: "admin",
        },
      ];
    },
  };

  const shell =
    await postgresAppShellState({
      user,
      session,
      identityRepository,
    });

  assert.equal(shell.state, "ready");

  assert.deepEqual(
    shell.activeOrganization,
    {
      id: "org-2",
      name: "Second Company",
      slug: "second-company",
    },
  );

  assert.deepEqual(
    shell.organizations,
    [
      {
        id: "org-1",
        name: "First Company",
        role: "owner",
      },
      {
        id: "org-2",
        name: "Second Company",
        role: "admin",
      },
    ],
  );
});

test("PostgreSQL app shell falls back to the first active membership", async () => {
  const user = {
    id: "user-1",
    email: "owner@example.com",
    displayName: "Owner",
    disabledAt: null,
  };

  const session = {
    id: "session-1",
    userId: user.id,
    activeOrganizationId:
      "missing-organization",
  };

  const identityRepository = {
    async activeMemberships() {
      return [
        {
          id: "membership-1",
          organizationId: "org-1",
          organizationName:
            "Primary Company",
          organizationSlug:
            "primary-company",
          role: "owner",
        },
      ];
    },
  };

  const shell =
    await postgresAppShellState({
      user,
      session,
      identityRepository,
    });

  assert.equal(shell.state, "ready");

  assert.equal(
    shell.activeOrganization.id,
    "org-1",
  );
});

test("PostgreSQL app shell returns disabled state for disabled users", async () => {
  const shell =
    await postgresAppShellState({
      user: {
        id: "user-1",
        email: "owner@example.com",
        displayName: "Owner",
        disabledAt: new Date(),
      },

      session: {
        id: "session-1",
      },

      identityRepository: {
        async activeMemberships() {
          throw new Error(
            "Should not query memberships.",
          );
        },
      },
    });

  assert.deepEqual(shell, {
    state: "disabled",
    message:
      "This account is disabled.",
  });
});