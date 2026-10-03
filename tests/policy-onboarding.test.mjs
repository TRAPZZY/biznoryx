import test from "node:test";
import assert from "node:assert/strict";

import {
  AuditLog,
  IdentityService,
  SessionService,
  createEmptyStore,
} from "../src/auth/core.mjs";

import { appShellState } from "../src/server/app-shell.mjs";

test("policy acceptance gates a verified account and records immutable audit evidence", () => {
  const store = createEmptyStore();

  const audit = new AuditLog(store);

  const identity = new IdentityService(store, audit);

  const sessions = new SessionService(store, audit);

  const user = identity.createUser({
    email: "policy-unit@example.com",
    displayName: "Policy Unit",
    password: "PolicyUnitPassword2026!",
    emailVerifiedAt: new Date(),
  });

  const result = sessions.createSessionForUser(user);

  const before = appShellState({
    user,
    session: result.session,
    store,
  });

  assert.equal(before.state, "policy_required");

  assert.equal(before.policy.required, true);

  assert.throws(
    () =>
      identity.acceptCurrentPolicy({
        userId: user.id,
        acknowledgements: {
          termsAccepted: true,
        },
      }),
    (error) => error?.code === "POLICY_ACCEPTANCE_REQUIRED",
  );

  const accepted = identity.acceptCurrentPolicy({
    userId: user.id,
    acknowledgements: {
      termsAccepted: true,
      privacyAccepted: true,
      dataAuthorityAccepted: true,
      guideAcknowledged: true,
    },
  });

  assert.equal(accepted.required, false);

  const after = appShellState({
    user,
    session: result.session,
    store,
  });

  assert.equal(after.state, "empty");

  const event = store.auditEvents.find(
    (item) => item.eventType === "identity.policy_accepted",
  );

  assert.ok(event);
  assert.equal(event.targetId, user.id);
  assert.equal(event.metadata.termsVersion, "2026-10-03");
  assert.equal(event.metadata.guideVersion, "2026-10-03");
});
