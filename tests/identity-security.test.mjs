import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { hashPassword, hashSecret } from "../src/auth/core.mjs";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";
import { createPostgresPool } from "../src/database/postgres.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const now = new Date("2026-10-05T12:00:00.000Z");
const sessionToken = "synthetic-security-session";
const csrfToken = "synthetic-security-csrf";
const userId = "00000000-0000-4000-8000-000000000027";
const sessionId = "20000000-0000-4000-8000-000000000027";
const organizationId = "10000000-0000-4000-8000-000000000027";

function createIdentityPool(overrides = {}) {
  const context = {
    session_id: sessionId,
    user_id: userId,
    email: "security-owner@example.invalid",
    display_name: "Security Owner",
    user_disabled_at: null,
    csrf_token_hash: hashSecret(csrfToken),
    active_organization_id: organizationId,
    membership_role: "viewer",
    membership_status: "active",
    session_revoked_at: null,
    session_expires_at: new Date(now.getTime() + 60_000),
    ...overrides,
  };
  const state = { revoked: false, lastSeen: false, released: false };
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const query = sql.replace(/\s+/g, " ").trim();
      calls.push({ query, params });
      if (["begin", "commit", "rollback"].includes(query)) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes("set_config('app.current_user_id'")) {
        assert.deepEqual(params, [userId]);
        return { rows: [], rowCount: 1 };
      }
      if (query.startsWith("update user_sessions set revoked_at")) {
        assert.deepEqual(params, [sessionId, userId]);
        assert.match(query, /where id = \$1 and user_id = \$2$/);
        state.revoked = true;
        context.session_revoked_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (query.startsWith("update user_sessions set last_seen_at")) {
        assert.deepEqual(params, [sessionId, now]);
        state.lastSeen = true;
        return { rows: [], rowCount: 1 };
      }
      assert.fail(`Unexpected identity transaction query: ${query}`);
    },
    release() {
      state.released = true;
    },
  };
  return {
    state,
    calls,
    async query(sql, params) {
      assert.match(sql, /from runtime_session_context\(\$1\)/);
      assert.deepEqual(params, [hashSecret(sessionToken)]);
      return { rows: [{ ...context }] };
    },
    async connect() {
      return client;
    },
  };
}

for (const scenario of ["disabled organization", "missing organization"]) {
  test(`authenticate rejects and revokes a ${scenario} context`, async () => {
    // Migration 0027 maps both cases to this unchanged function result shape.
    const pool = createIdentityPool({ membership_status: "disabled" });
    const repository = new PostgresIdentityRepository(pool, { now: () => now });

    await assert.rejects(
      repository.authenticate({
        token: sessionToken,
        csrfToken,
        requireCsrf: true,
      }),
      { code: "MEMBERSHIP_DISABLED" },
    );
    assert.equal(pool.state.revoked, true);
    assert.equal(pool.state.lastSeen, false);
    assert.equal(pool.state.released, true);
    assert.deepEqual(
      pool.calls.map(({ query }) => query.split(" ")[0]),
      ["begin", "select", "update", "commit"],
    );

    await assert.rejects(repository.authenticate({ token: sessionToken }), {
      code: "SESSION_INVALID",
    });
    assert.equal(pool.calls.length, 4);
  });
}

test("authenticate fails closed for a missing membership in an active organization", async () => {
  const pool = createIdentityPool({
    membership_role: null,
    membership_status: null,
  });
  const repository = new PostgresIdentityRepository(pool, { now: () => now });
  await assert.rejects(repository.authenticate({ token: sessionToken }), {
    code: "MEMBERSHIP_DISABLED",
  });
  assert.equal(pool.state.revoked, true);
  assert.equal(pool.state.lastSeen, false);
});

test("authenticate preserves active organization access", async () => {
  const pool = createIdentityPool();
  const repository = new PostgresIdentityRepository(pool, { now: () => now });
  const context = await repository.authenticate({
    token: sessionToken,
    csrfToken,
    requireCsrf: true,
  });
  assert.equal(context.user.id, userId);
  assert.equal(context.session.id, sessionId);
  assert.equal(context.session.activeOrganizationId, organizationId);
  assert.equal(context.membership.status, "active");
  assert.equal(pool.state.revoked, false);
  assert.equal(pool.state.lastSeen, true);
});

test("authenticate preserves organization-free sessions", async () => {
  const pool = createIdentityPool({
    active_organization_id: null,
    membership_role: null,
    membership_status: null,
  });
  const repository = new PostgresIdentityRepository(pool, { now: () => now });
  const context = await repository.authenticate({ token: sessionToken });
  assert.equal(context.session.activeOrganizationId, null);
  assert.equal(context.membership, null);
  assert.equal(pool.state.revoked, false);
  assert.equal(pool.state.lastSeen, true);
});

for (const [scenario, overrides, code] of [
  ["disabled user", { user_disabled_at: now }, "USER_DISABLED"],
  ["expired session", { session_expires_at: now }, "SESSION_INVALID"],
  ["revoked session", { session_revoked_at: now }, "SESSION_INVALID"],
]) {
  test(`authenticate rejects a ${scenario} before touching the session`, async () => {
    const pool = createIdentityPool(overrides);
    const repository = new PostgresIdentityRepository(pool, { now: () => now });
    await assert.rejects(repository.authenticate({ token: sessionToken }), {
      code,
    });
    assert.equal(pool.calls.length, 0);
  });
}

test("authenticate still rejects an invalid CSRF token", async () => {
  const pool = createIdentityPool();
  const repository = new PostgresIdentityRepository(pool, { now: () => now });
  await assert.rejects(
    repository.authenticate({
      token: sessionToken,
      csrfToken: "wrong",
      requireCsrf: true,
    }),
    { code: "CSRF_INVALID" },
  );
  assert.equal(pool.calls.length, 0);
});

function deferred() {
  return Promise.withResolvers();
}

function createConcurrentIdentityPool({
  verified = true,
  onMemberships,
  onChallenge,
} = {}) {
  const user = {
    id: userId,
    email: "security-owner@example.invalid",
    display_name: "Security Owner",
    password_hash: hashPassword("Original-Security-Password!"),
    email_verified_at: verified ? now : null,
    disabled_at: null,
  };
  const state = {
    user,
    sessions: [],
    consumed: false,
    connections: 0,
    failAudit: false,
  };
  const lockWait = deferred();
  const calls = [];
  let owner = null;
  const waiters = [];

  async function lock(client) {
    if (owner === client) return;
    if (owner) {
      lockWait.resolve();
      await new Promise((resolve) => waiters.push({ client, resolve }));
    } else {
      owner = client;
    }
  }

  function unlock(client) {
    if (owner !== client) return;
    const next = waiters.shift();
    owner = next?.client ?? null;
    next?.resolve();
  }

  function contextFor(tokenHash) {
    const session = state.sessions.find(
      (item) => item.session_token_hash === tokenHash,
    );
    return session
      ? [
          {
            ...session,
            user_id: user.id,
            email: user.email,
            display_name: user.display_name,
            user_disabled_at: user.disabled_at,
            membership_role: null,
            membership_status: null,
          },
        ]
      : [];
  }

  const pool = {
    state,
    calls,
    lockWait,
    async query(sql, params) {
      // Preserve the old unlocked read so the regression also runs on the baseline.
      if (sql.includes("from app_users")) return { rows: [{ ...user }] };
      if (sql.includes("from runtime_session_context"))
        return { rows: contextFor(params[0]) };
      assert.fail("Unexpected pool query");
    },
    async connect() {
      state.connections += 1;
      const changes = {
        user: null,
        sessions: [],
        revoke: false,
        consumed: false,
      };
      const client = {
        async query(sql, params = []) {
          const query = sql.replace(/\s+/g, " ").trim();
          calls.push({ client, query });
          if (query === "begin") return { rows: [], rowCount: 0 };
          if (query === "commit") {
            if (changes.user) Object.assign(user, changes.user);
            state.sessions.push(...changes.sessions);
            if (changes.revoke) {
              for (const session of state.sessions)
                session.session_revoked_at = now;
            }
            if (changes.consumed) state.consumed = true;
            unlock(client);
            return { rows: [], rowCount: 0 };
          }
          if (query === "rollback") {
            unlock(client);
            return { rows: [], rowCount: 0 };
          }
          if (query.startsWith("select set_config"))
            return { rows: [], rowCount: 1 };
          if (query.includes("from app_users")) {
            if (/for update$/i.test(query)) await lock(client);
            const current = { ...user, ...changes.user };
            const eligible =
              !query.includes("email_verified_at is not null") ||
              current.email_verified_at;
            return { rows: eligible && !current.disabled_at ? [current] : [] };
          }
          if (query.includes("from runtime_active_memberships")) {
            await onMemberships?.();
            return { rows: [] };
          }
          if (query.includes("from email_verification_challenges")) {
            await onChallenge?.();
            return {
              rows: state.consumed
                ? []
                : [
                    {
                      id: "security-challenge",
                      code_hash: hashSecret("12345678"),
                      attempts: 0,
                      max_attempts: 5,
                      expires_at: new Date(now.getTime() + 600_000),
                    },
                  ],
            };
          }
          if (query.startsWith("update email_verification_challenges")) {
            changes.consumed = true;
            return { rows: [], rowCount: 1 };
          }
          if (query.startsWith("update app_users")) {
            await lock(client);
            changes.user = query.includes("password_hash")
              ? {
                  password_hash: params[1],
                  ...(query.includes("email_verified_at =")
                    ? { email_verified_at: params[2] }
                    : {}),
                }
              : { email_verified_at: params[1] };
            return { rows: [{ ...user, ...changes.user }], rowCount: 1 };
          }
          if (query.startsWith("insert into user_sessions")) {
            changes.sessions.push({
              session_id: params[0],
              session_token_hash: params[2],
              csrf_token_hash: params[3],
              active_organization_id: params[4],
              session_expires_at: params[5],
              session_revoked_at: null,
            });
            return { rows: [], rowCount: 1 };
          }
          if (query.startsWith("update user_sessions set revoked_at")) {
            changes.revoke = true;
            return { rows: [], rowCount: state.sessions.length };
          }
          if (query.startsWith("update user_sessions set last_seen_at"))
            return { rows: [], rowCount: 1 };
          if (query.startsWith("insert into audit_events")) {
            if (state.failAudit) throw new Error("Synthetic audit failure");
            return { rows: [], rowCount: 1 };
          }
          assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {
          assert.notEqual(
            owner,
            client,
            "User lock must end before releasing the client",
          );
        },
      };
      return client;
    },
  };
  return pool;
}

test("reset revokes a sign-in session even when sign-in pauses after password validation", async () => {
  const reached = deferred();
  const resume = deferred();
  const pool = createConcurrentIdentityPool({
    onMemberships: async () => {
      reached.resolve();
      await resume.promise;
    },
  });
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const signIn = identity.signIn({
    email: pool.state.user.email,
    password: "Original-Security-Password!",
  });
  await reached.promise;
  const reset = verification.resetPassword({
    email: pool.state.user.email,
    code: "12345678",
    newPassword: "Replacement-Security-Password!",
  });
  // Baseline reset completes; the fixed reset waits for the sign-in's user lock.
  await Promise.race([pool.lockWait.promise, reset]);
  resume.resolve();
  const [signedIn] = await Promise.all([signIn, reset]);
  await assert.rejects(identity.authenticate({ token: signedIn.token }), {
    code: "SESSION_INVALID",
  });
  assert.equal(pool.state.sessions.length, 1);
  assert.equal(
    pool.state.connections,
    2,
    "Sign-in must reuse one transaction for memberships and session creation",
  );
});

test("sign-in queued behind reset cannot validate the old password", async () => {
  const reached = deferred();
  const resume = deferred();
  const pool = createConcurrentIdentityPool({
    onChallenge: async () => {
      reached.resolve();
      await resume.promise;
    },
  });
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const reset = verification.resetPassword({
    email: pool.state.user.email,
    code: "12345678",
    newPassword: "Replacement-Security-Password!",
  });
  await reached.promise;
  const denied = assert.rejects(
    identity.signIn({
      email: pool.state.user.email,
      password: "Original-Security-Password!",
    }),
    { code: "INVALID_CREDENTIALS" },
  );
  await Promise.race([pool.lockWait.promise, denied]);
  resume.resolve();
  await Promise.all([reset, denied]);
  assert.equal(pool.state.sessions.length, 0);
});

test("verification session handoff rejects credentials made stale by reset", async () => {
  const pool = createConcurrentIdentityPool();
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const verifiedUser = await verification.verify({
    email: pool.state.user.email,
    code: "12345678",
  });
  pool.state.consumed = false;
  await verification.resetPassword({
    email: pool.state.user.email,
    code: "12345678",
    newPassword: "Replacement-Security-Password!",
  });
  await assert.rejects(identity.createSessionForUser(verifiedUser), {
    code: "INVALID_CREDENTIALS",
  });
  assert.equal(pool.state.sessions.length, 0);
});

test("session creation rechecks account disablement after OTP verification", async () => {
  const pool = createConcurrentIdentityPool();
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const verifiedUser = await verification.verify({
    email: pool.state.user.email,
    code: "12345678",
  });
  pool.state.user.disabled_at = now;
  await assert.rejects(identity.createSessionForUser(verifiedUser), {
    code: "INVALID_CREDENTIALS",
  });
  assert.equal(pool.state.sessions.length, 0);
});

test("first verification invalidates the provisional password before any new session", async () => {
  const pool = createConcurrentIdentityPool({ verified: false });
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const verifiedUser = await verification.verify({
    email: pool.state.user.email,
    code: "12345678",
    newPassword: "Mailbox-Owner-Password!",
  });
  await assert.rejects(
    identity.signIn({
      email: pool.state.user.email,
      password: "Original-Security-Password!",
    }),
    { code: "INVALID_CREDENTIALS" },
  );
  const verifiedSession = await identity.createSessionForUser(verifiedUser);
  assert.equal(
    (await identity.authenticate({ token: verifiedSession.token })).user.id,
    userId,
  );
  const signedIn = await identity.signIn({
    email: pool.state.user.email,
    password: "Mailbox-Owner-Password!",
  });
  assert.equal(signedIn.user.id, userId);
  assert.equal(JSON.stringify(verifiedUser).includes("password"), false);
  assert.equal(
    JSON.stringify(signedIn).includes(pool.state.user.password_hash),
    false,
  );
});

test("a failed session audit rolls back session insertion and releases the user lock", async () => {
  const pool = createConcurrentIdentityPool();
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  pool.state.failAudit = true;
  await assert.rejects(
    identity.signIn({
      email: pool.state.user.email,
      password: "Original-Security-Password!",
    }),
    /Synthetic audit failure/,
  );
  assert.equal(pool.state.sessions.length, 0);
  pool.state.failAudit = false;
  assert.equal(
    (
      await identity.signIn({
        email: pool.state.user.email,
        password: "Original-Security-Password!",
      })
    ).user.id,
    userId,
  );
});

for (const operation of ["reset", "first verification"]) {
  test(`${operation} rolls back credentials and code consumption on audit failure`, async () => {
    const pool = createConcurrentIdentityPool({
      verified: operation !== "first verification",
    });
    const verification = new PostgresEmailVerificationRepository(pool, {
      now: () => now,
    });
    const originalHash = pool.state.user.password_hash;
    pool.state.failAudit = true;
    const input = {
      email: pool.state.user.email,
      code: "12345678",
      newPassword: "Owner-Replacement-Password!",
    };
    await assert.rejects(
      operation === "reset"
        ? verification.resetPassword(input)
        : verification.verify(input),
      /Synthetic audit failure/,
    );
    assert.equal(pool.state.user.password_hash, originalHash);
    assert.equal(pool.state.consumed, false);
    assert.equal(pool.state.sessions.length, 0);
  });
}

test("confirmed-account OTP reauthentication leaves its existing password usable", async () => {
  const pool = createConcurrentIdentityPool();
  const identity = new PostgresIdentityRepository(pool, { now: () => now });
  const verification = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
  });
  const originalHash = pool.state.user.password_hash;
  const verifiedUser = await verification.verify({
    email: pool.state.user.email,
    code: "12345678",
    newPassword: "Ignored-Replacement-Password!",
  });
  assert.equal(pool.state.user.password_hash, originalHash);
  await identity.createSessionForUser(verifiedUser);
  await identity.signIn({
    email: pool.state.user.email,
    password: "Original-Security-Password!",
  });
  await assert.rejects(
    identity.signIn({
      email: pool.state.user.email,
      password: "Ignored-Replacement-Password!",
    }),
    { code: "INVALID_CREDENTIALS" },
  );
});

function assertPublicAuthResponse(body, passwords) {
  const encoded = JSON.stringify(body);
  assert.doesNotMatch(encoded, /password|pbkdf2|password_hash/i);
  for (const password of passwords)
    assert.equal(encoded.includes(password), false);
}

test(
  "real PostgreSQL first verification, reauthentication and reset keep authentication responses credential-free",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPostgresPool({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      NODE_ENV: "test",
    });
    const identity = new PostgresIdentityRepository(pool);
    const delivered = [];
    const verification = new PostgresEmailVerificationRepository(pool, {
      emailSender: {
        async sendVerificationCode(input) {
          delivered.push(input);
        },
      },
    });
    const { server } = createProductionApp({
      identityRepository: identity,
      emailVerificationRepository: verification,
      objectStorage: {},
      production: false,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const email = `identity-security-${randomUUID()}@example.invalid`;
    const provisional = "Provisional-Registration-Password!";
    const confirmed = "Mailbox-Owner-Confirmed-Password!";
    const replacement = "Mailbox-Owner-Reset-Password!";
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) =>
      fetch(`${base}/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const registration = await post("register", {
        email,
        displayName: "Security Regression",
        password: provisional,
      });
      assert.equal(registration.status, 201);
      const code = delivered.at(-1).code;
      const missingPassword = await post("auth/verify-email", { email, code });
      assert.equal(missingPassword.status, 400);
      assert.equal((await missingPassword.json()).error, "WEAK_PASSWORD");
      const first = await post("auth/verify-email", {
        email,
        code,
        newPassword: confirmed,
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assertPublicAuthResponse(firstBody, [provisional, confirmed]);
      assert.equal(firstBody.authenticated, true);
      await assert.rejects(identity.signIn({ email, password: provisional }), {
        code: "INVALID_CREDENTIALS",
      });
      const loggedIn = await post("sign-in", { email, password: confirmed });
      assert.equal(loggedIn.status, 200);
      assertPublicAuthResponse(await loggedIn.json(), [provisional, confirmed]);
      await verification.issue({ email });
      const reauthentication = await post("auth/verify-email", {
        email,
        code: delivered.at(-1).code,
        newPassword: replacement,
      });
      assert.equal(reauthentication.status, 200);
      assertPublicAuthResponse(await reauthentication.json(), [
        confirmed,
        replacement,
      ]);
      const session = await identity.signIn({ email, password: confirmed });
      await assert.rejects(identity.signIn({ email, password: replacement }), {
        code: "INVALID_CREDENTIALS",
      });
      await verification.issue({ email, purpose: "password_reset" });
      const reset = await post("auth/password-reset/confirm", {
        email,
        code: delivered.at(-1).code,
        newPassword: replacement,
      });
      assert.equal(reset.status, 200);
      assertPublicAuthResponse(await reset.json(), [confirmed, replacement]);
      await assert.rejects(identity.authenticate({ token: session.token }), {
        code: "SESSION_INVALID",
      });
      const resetSignIn = await post("sign-in", {
        email,
        password: replacement,
      });
      assert.equal(resetSignIn.status, 200);
      assertPublicAuthResponse(await resetSignIn.json(), [
        confirmed,
        replacement,
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    }
  },
);
