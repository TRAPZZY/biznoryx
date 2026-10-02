import assert from "node:assert/strict";
import test from "node:test";

import { hashSecret } from "../src/auth/core.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";

const resetCode = "12345678";
const resetAt = new Date("2026-10-01T12:00:00.000Z");

function createResetPool({ code = resetCode, userExists = true } = {}) {
  const calls = [];
  const state = {
    attempts: 0,
    consumed: false,
    passwordHash: null,
    revoked: false,
    auditRecorded: false,
  };

  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      calls.push({ query, params });

      if (["begin", "commit", "rollback"].includes(query)) {
        return { rows: [], rowCount: 0 };
      }

      if (query.includes("from email_verification_challenges")) {
        return {
          rows: state.consumed
            ? []
            : [{
                id: "challenge-1",
                code_hash: hashSecret(code),
                attempts: state.attempts,
                max_attempts: 5,
                expires_at: new Date(resetAt.getTime() + 600_000),
              }],
        };
      }

      if (query.includes("update email_verification_challenges")) {
        state.attempts = params[1];
        if (params[2] >= 5 || params[3] === true) {
          state.consumed = true;
        }
        if (query.includes("consumed_at = $3")) {
          state.consumed = true;
        }
        return { rows: [], rowCount: 1 };
      }

      if (query.includes("update app_users")) {
        state.passwordHash = params[1];
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
        rows: userExists
          ? [{ id: "user-1" }]
          : [],
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
    pool.calls.some(({ query }) => query.includes("identity.password_reset_completed")),
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