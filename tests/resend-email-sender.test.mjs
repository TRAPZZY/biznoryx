import assert from "node:assert/strict";
import test from "node:test";

import { hashSecret } from "../src/auth/core.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";
import { EmailDeliveryError, ResendEmailSender } from "../src/email/resend-email-sender.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const from = "BIZNORYX <verify@biznoryx.com>";
const message = () => ({
  to: "owner@example.test",
  code: "01234567",
  expiresAt: new Date(Date.now() + 600_000),
  challengeId: "synthetic-challenge",
});

function sender(fetchImpl) {
  return new ResendEmailSender({ apiKey: "synthetic-email-key", from, fetchImpl });
}

for (const purpose of ["email_verification", "password_reset"]) {
  test(`${purpose} preserves sender, multipart content and idempotency without tracking assets`, async () => {
    const input = { ...message(), purpose };
    const transport = sender(async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Idempotency-Key"], `email-code/${purpose}/${input.challengeId}`);
      assert.equal(options.headers.Authorization, "Bearer synthetic-email-key");
      const payload = JSON.parse(options.body);
      assert.equal(payload.from, from);
      assert.deepEqual(payload.to, [input.to]);
      assert.equal(payload.subject, purpose === "password_reset"
        ? "Reset your BIZNORYX password" : "Your BIZNORYX verification code");
      for (const content of [payload.text, payload.html]) {
        assert.ok(content.includes(input.code));
        assert.match(content, /This code expires in 10 minutes\./);
        assert.match(content, /If you did not request this code/);
        assert.match(content, /BIZNORYX/);
        assert.doesNotMatch(content, /https?:\/\/|<img\b|<a\b|<script\b/i);
      }
      assert.equal(payload.reply_to, undefined);
      assert.equal(payload.attachments, undefined);
      assert.equal(payload.headers, undefined);
      return Response.json({ id: "synthetic-message" });
    });
    assert.deepEqual(await transport.sendVerificationCode(input), {
      provider: "resend", messageId: "synthetic-message",
    });
  });
}

for (const status of [403, 429, 500]) {
  test(`Resend HTTP ${status} is a delivery error, not successful delivery`, async () => {
    const transport = sender(async () => Response.json({ message: "Provider rejected request." }, { status }));
    await assert.rejects(transport.sendVerificationCode(message()), error =>
      error instanceof EmailDeliveryError && error.status === status);
  });
}

test("a malformed Resend success response is rejected", async () => {
  const transport = sender(async () => Response.json({}));
  await assert.rejects(transport.sendVerificationCode(message()), EmailDeliveryError);
});

test("a Resend network failure is sanitized and classified as a delivery error", async () => {
  const transport = sender(async () => {
    throw new TypeError("Synthetic transport failure with private details");
  });
  await assert.rejects(transport.sendVerificationCode(message()), error =>
    error instanceof EmailDeliveryError && error.status === null &&
    !error.message.includes("private details"));
});

// This fake stores only issue() SQL effects; no production database or email provider is used.
function issuancePool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    calls,
    async query() { return { rows: [{ id: "user-1" }] }; },
    async connect() { return client; },
  };
}

test("issuing and resending codes preserves expiry, hashed storage and supersession", async () => {
  const pool = issuancePool();
  const now = new Date("2026-10-14T12:00:00Z");
  const delivered = [];
  const repository = new PostgresEmailVerificationRepository(pool, {
    now: () => now,
    emailSender: { async sendVerificationCode(input) { delivered.push(input); } },
  });
  for (let i = 0; i < 2; i++) {
    const result = await repository.issue({ email: "OWNER@example.test" });
    assert.equal(result.email, "owner@example.test");
    assert.equal(result.expiresAt.getTime() - now.getTime(), 600_000);
    assert.equal(result.code, undefined);
    assert.equal(result.reviewCode, undefined);
  }
  assert.equal(delivered.length, 2);
  assert.notEqual(delivered[0].challengeId, delivered[1].challengeId);
  const inserts = pool.calls.filter(({ sql }) => sql.includes("insert into email_verification_challenges"));
  for (let i = 0; i < 2; i++) {
    assert.match(delivered[i].code, /^\d{8}$/);
    assert.equal(inserts[i].params[4], hashSecret(delivered[i].code));
    assert.equal(inserts[i].params[5], 5);
  }
  assert.equal(pool.calls.filter(({ sql }) => sql.includes("set consumed_at = $3") &&
    sql.includes("superseded_at = $3")).length, 2);
});

for (const native of [false, true]) {
  for (const failing of [false, true]) {
    test(`${native ? "Android" : "browser"} registration and resend ${failing ? "handle network failure safely" : "send code-only messages"}`, async () => {
      const pool = issuancePool();
      const deliveries = [];
      const emailSender = sender(async (_url, options) => {
        if (failing) throw new TypeError("Synthetic private transport details");
        deliveries.push(JSON.parse(options.body));
        return Response.json({ id: "synthetic-message" });
      });
      const repository = new PostgresEmailVerificationRepository(pool, { emailSender });
      const { server } = createProductionApp({
        identityRepository: { async createUser(input) { return { ...input, id: "user-1" }; } },
        emailVerificationRepository: repository,
        production: false,
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { "content-type": "application/json", ...(native
        ? { "x-biznoryx-client": "mobile-v1" }
        : { origin: base, "sec-fetch-site": "same-origin" }) };
      try {
        for (const path of ["/api/register", "/api/auth/resend-code"]) {
          const response = await fetch(base + path, {
            method: "POST", headers, body: JSON.stringify({
              email: "owner@example.test", displayName: "Owner", password: "Synthetic-Password-2026!",
            }),
          });
          const body = await response.json();
          assert.equal(response.status, failing ? 503 : path === "/api/register" ? 201 : 200);
          assert.equal(response.headers.get("set-cookie"), null);
          assert.equal(body.code, undefined);
          assert.equal(body.sessionToken, undefined);
          if (failing) {
            assert.equal(body.error, "EMAIL_DELIVERY_FAILED");
            assert.doesNotMatch(JSON.stringify(body), /private transport/);
          }
        }
        if (failing) {
          assert.equal(pool.calls.filter(({ sql }) => sql.includes("consumed_at = coalesce")).length, 2);
        } else {
          assert.equal(deliveries.length, 2);
          assert.ok(deliveries.every(payload => payload.from === from && /^\d{8}$/.test(
            payload.text.match(/Your verification code is: (\d+)/)?.[1])));
        }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
