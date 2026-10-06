import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, hashSecret, verifyPassword } from "../src/auth/core.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";

const resetCode = "12345678";
const resetAt = new Date("2026-10-01T12:00:00.000Z");
const provisionalHash = hashPassword("Provisional-Registration-Password!");

function createResetPool({
  code = resetCode,
  userExists = true,
  verified = true,
} = {}) {
  const calls = [];
  const state = {
    attempts: 0,
    consumed: false,
    passwordHash: null,
    revoked: false,
    auditRecorded: false,
    verifiedAt: verified ? resetAt : null,
  };
  let snapshot;

  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      calls.push({ query, params });

      if (query === "begin") {
        snapshot = { ...state };
        return { rows: [], rowCount: 0 };
      }
      if (query === "rollback") {
        Object.assign(state, snapshot);
        return { rows: [], rowCount: 0 };
      }
      if (query === "commit") {
        return { rows: [], rowCount: 0 };
      }

      if (query.includes("from app_users")) {
        return {
          rows: userExists
            ? [
                {
                  id: "user-1",
                  email: "owner@example.com",
                  display_name: "Owner",
                  password_hash: state.passwordHash ?? provisionalHash,
                  email_verified_at: state.verifiedAt,
                  disabled_at: null,
                },
              ]
            : [],
        };
      }

      if (query.includes("from email_verification_challenges")) {
        return {
          rows: state.consumed
            ? []
            : [
                {
                  id: "challenge-1",
                  code_hash: hashSecret(code),
                  attempts: state.attempts,
                  max_attempts: 5,
                  expires_at: new Date(resetAt.getTime() + 600_000),
                },
              ],
        };
      }

      if (query.includes("update email_verification_challenges")) {
        state.attempts = params[1];
        if (params[1] >= 5 || params[2] === true) {
          state.consumed = true;
        }
        if (query.includes("consumed_at = $3")) {
          state.consumed = true;
        }
        return { rows: [], rowCount: 1 };
      }

      if (query.includes("update app_users")) {
        if (query.includes("password_hash")) state.passwordHash = params[1];
        if (query.includes("email_verified_at =")) state.verifiedAt = params[2];
        return { rows: [], rowCount: 1 };
      }

      if (query.includes("update user_sessions")) {
        state.revoked = true;
        return { rows: [], rowCount: 2 };
      }

      if (query.includes("identity.password_reset_completed")) {
        state.auditRecorded = true;
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const pool = {
    calls,
    state,
    async query(sql) {
      calls.push({ query: String(sql), params: [] });
      return {
        rows: userExists ? [{ id: "user-1" }] : [],
      };
    },
    async connect() {
      return {
        ...client,
        release() {},
      };
    },
  };

  return pool;
}

test("password reset consumes the code, replaces the hash, revokes sessions, and audits", async () => {
  const pool = createResetPool();
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => resetAt,
  });

  assert.deepEqual(
    await repository.resetPassword({
      email: "owner@example.com",
      code: resetCode,
      newPassword: "A-New-Long-Password-2026!",
    }),
    { reset: true },
  );

  assert.match(pool.state.passwordHash, /^pbkdf2_sha512\$210000\$/);
  assert.doesNotMatch(pool.state.passwordHash, /A-New-Long-Password-2026!/);
  assert.equal(pool.state.consumed, true);
  assert.equal(pool.state.revoked, true);
  assert.equal(pool.state.auditRecorded, true);
  assert.ok(
    pool.calls.some(({ query }) => query.includes("set password_hash")),
  );
  assert.ok(
    pool.calls.some(({ query }) =>
      query.includes("identity.password_reset_completed"),
    ),
  );
  assert.ok(
    pool.calls.every(({ query }) => !query.includes("email_verified_at =")),
  );

  await assert.rejects(
    repository.resetPassword({
      email: "owner@example.com",
      code: resetCode,
      newPassword: "Another-New-Password-2026!",
    }),
    (error) => error.code === "EMAIL_CODE_INVALID",
  );
});

test("invalid password reset codes consume attempts without changing credentials", async () => {
  const pool = createResetPool();
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => resetAt,
  });

  await assert.rejects(
    repository.resetPassword({
      email: "owner@example.com",
      code: "87654321",
      newPassword: "A-New-Long-Password-2026!",
    }),
    (error) => error.code === "EMAIL_CODE_INVALID",
  );

  assert.equal(pool.state.attempts, 1);
  assert.equal(pool.state.passwordHash, null);
  assert.equal(pool.state.revoked, false);
  assert.equal(pool.state.auditRecorded, false);
});

test("password reset does not reveal or mutate an unknown account", async () => {
  const pool = createResetPool({ userExists: false });
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => resetAt,
  });

  await assert.rejects(
    repository.resetPassword({
      email: "unknown@example.com",
      code: resetCode,
      newPassword: "A-New-Long-Password-2026!",
    }),
    (error) => error.code === "EMAIL_CODE_INVALID",
  );

  assert.equal(pool.state.passwordHash, null);
  assert.equal(pool.state.revoked, false);
  assert.equal(pool.state.auditRecorded, false);
});

test("password reset locks the user before locking or consuming the challenge", async () => {
  const pool = createResetPool();
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => resetAt,
  });
  await repository.resetPassword({
    email: "owner@example.com",
    code: resetCode,
    newPassword: "Owner-Selected-Password!",
  });
  const userLock = pool.calls.findIndex(
    ({ query }) =>
      query.includes("from app_users") && /for update/i.test(query),
  );
  const challengeLock = pool.calls.findIndex(({ query }) =>
    query.includes("from email_verification_challenges"),
  );
  assert.ok(userLock >= 0 && userLock < challengeLock);
});

for (const newPassword of [
  undefined,
  "",
  "x".repeat(11),
  "x".repeat(129),
  12345,
]) {
  test(`first verification rejects invalid password ${typeof newPassword === "string" ? newPassword.length : typeof newPassword}`, async () => {
    const pool = createResetPool({ verified: false });
    const repository = new PostgresEmailVerificationRepository(pool, {
      now: () => resetAt,
    });
    await assert.rejects(
      repository.verify({
        email: "owner@example.com",
        code: resetCode,
        newPassword,
      }),
      { code: "WEAK_PASSWORD" },
    );
    assert.equal(pool.state.verifiedAt, null);
    assert.equal(pool.state.passwordHash, null);
    assert.equal(pool.state.consumed, false);
    assert.equal(pool.state.revoked, false);
    assert.ok(pool.calls.some(({ query }) => query === "rollback"));
  });
}

for (const length of [12, 128]) {
  test(`first verification accepts a ${length}-character owner password and revokes provisional sessions`, async () => {
    const pool = createResetPool({ verified: false });
    const repository = new PostgresEmailVerificationRepository(pool, {
      now: () => resetAt,
    });
    const user = await repository.verify({
      email: "owner@example.com",
      code: resetCode,
      newPassword: "x".repeat(length),
    });
    assert.equal(user.id, "user-1");
    assert.equal(user.emailVerifiedAt, resetAt);
    assert.equal(
      verifyPassword("x".repeat(length), pool.state.passwordHash),
      true,
    );
    assert.equal(
      verifyPassword(
        "Provisional-Registration-Password!",
        pool.state.passwordHash,
      ),
      false,
    );
    assert.equal(pool.state.consumed, true);
    assert.equal(pool.state.revoked, true);
    assert.equal(JSON.stringify(user).includes(pool.state.passwordHash), false);
    assert.match(
      pool.calls.find(({ query }) => query.includes("from app_users")).query,
      /for update/i,
    );
  });
}

for (const newPassword of [
  undefined,
  "Ignored-Reauthentication-Password!",
  "short",
]) {
  test(`verified-account OTP reauthentication preserves password when newPassword is ${newPassword === undefined ? "absent" : newPassword.length}`, async () => {
    const pool = createResetPool();
    const repository = new PostgresEmailVerificationRepository(pool, {
      now: () => new Date(resetAt.getTime() + 1000),
    });
    const user = await repository.verify({
      email: "owner@example.com",
      code: resetCode,
      newPassword,
    });
    assert.equal(user.emailVerifiedAt, resetAt);
    assert.equal(pool.state.passwordHash, null);
    assert.equal(pool.state.revoked, false);
    assert.equal(pool.state.consumed, true);
    assert.equal(
      pool.calls.some(({ query }) => query.includes("update app_users")),
      false,
    );
  });
}

test("first verification with an invalid OTP cannot replace credentials", async () => {
  const pool = createResetPool({ verified: false });
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => resetAt,
  });
  await assert.rejects(
    repository.verify({
      email: "owner@example.com",
      code: "87654321",
      newPassword: "Owner-Selected-Password!",
    }),
    { code: "EMAIL_CODE_INVALID" },
  );
  assert.equal(pool.state.attempts, 1);
  assert.equal(pool.state.verifiedAt, null);
  assert.equal(pool.state.passwordHash, null);
  assert.equal(pool.state.revoked, false);
});
