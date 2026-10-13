import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const connectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL native and browser onboarding preserve session, CSRF and tenant boundaries", { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  let clock = new Date();
  const now = () => clock;
  const messages = new Map();
  const identity = new PostgresIdentityRepository(pool, { now, production: true });
  const verification = new PostgresEmailVerificationRepository(pool, { now, emailSender: {
    async sendVerificationCode(message) { messages.set(message.to, message); },
  } });
  const { server } = createProductionApp({ identityRepository: identity, emailVerificationRepository: verification, production: false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, headers, body) => fetch(`${base}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const accounts = [];
  try {
    for (const native of [true, false]) {
      await t.test(native ? "native registration through onboarding persists without browser CSRF" : "browser registration through onboarding keeps cookies and CSRF", async () => {
        const email = `native-auth-${randomUUID()}@example.com`;
        const password = "DisposableAuthPassword2026!";
        const headers = native ? { "X-Biznoryx-Client": "mobile-v1" } : { Origin: base, "Sec-Fetch-Site": "same-origin" };
        const registered = await request("register", headers, { email, password, displayName: "Disposable Auth Test" });
        assert.equal(registered.status, 201);
        assert.equal((await registered.json()).requiresEmailVerification, true);
        const unverified = await request("sign-in", headers, { email, password });
        assert.equal(unverified.status, 403);
        const code = messages.get(email).code;
        const verified = await request("auth/verify-email", headers, { email, code, newPassword: password });
        assert.equal(verified.status, 200);
        const initial = await verified.json();
        assert.equal(initial.shell.state, "policy_required");
        if (native) {
          assert.ok(/^[A-Za-z0-9_-]{43}$/.test(initial.sessionToken), "Native credential has the expected opaque format.");
          assert.equal(verified.headers.get("set-cookie"), null);
          headers.Authorization = `Bearer ${initial.sessionToken}`;
        } else {
          assert.equal(initial.sessionToken, undefined);
          for (const flag of ["HttpOnly", "Secure", "SameSite=Lax"]) {
            assert.ok(verified.headers.get("set-cookie").split("; ").includes(flag), `Browser cookie requires ${flag}.`);
          }
          headers.Cookie = verified.headers.get("set-cookie").split(";")[0];
          headers["X-CSRF-Token"] = initial.csrfToken;
        }
        assert.equal((await request("auth/verify-email", headers, { email, code, newPassword: password })).status, 400);
        const policy = await request("account/policy-acceptance", headers, {
          termsAccepted: true, privacyAccepted: true, dataAuthorityAccepted: true, guideAcknowledged: true,
        });
        assert.equal(policy.status, 200);
        if (!native) {
          const wrong = { ...headers, "X-CSRF-Token": "incorrect" };
          const rejected = await request("organizations", wrong, { name: "Must Not Exist" });
          assert.equal(rejected.status, 403);
          assert.equal((await rejected.json()).message, "Invalid CSRF token.");
        }
        const created = await request("organizations", headers, { name: `Auth Test ${randomUUID()}` });
        assert.equal(created.status, 201);
        const organization = (await created.json()).organization;
        const restored = await request("session", headers);
        assert.equal(restored.status, 200);
        const restoredBody = await restored.json();
        assert.equal(restoredBody.authenticated, true);
        assert.equal(restoredBody.shell.activeOrganization.id, organization.id);
        if (!native) headers["X-CSRF-Token"] = restoredBody.csrfToken;
        assert.equal((await request("organizations/switch", headers, { organizationId: organization.id })).status, 200);
        const wrongPassword = await request("sign-in", native ? { "X-Biznoryx-Client": "mobile-v1" } : { Origin: base }, { email, password: "WrongPassword2026!" });
        assert.equal(wrongPassword.status, 401);
        accounts.push({ native, email, password, headers, organization });
      });
    }
    await t.test("native session cannot select another tenant or fall back to a cookie", async () => {
      const [native, browser] = accounts;
      const denied = await request("organizations/switch", native.headers, { organizationId: browser.organization.id });
      assert.equal(denied.status, 404);
      const cookieOnly = { "X-Biznoryx-Client": "mobile-v1", Cookie: browser.headers.Cookie };
      assert.equal((await request("organizations/switch", cookieOnly, { organizationId: browser.organization.id })).status, 401);
      assert.equal((await request("organizations/switch", { ...cookieOnly, Authorization: "Bearer invalid" }, { organizationId: browser.organization.id })).status, 401);
      assert.equal((await request("organizations/switch", { ...native.headers, Origin: "https://untrusted.example" }, { organizationId: native.organization.id })).status, 403);
      const session = await (await request("session", native.headers)).json();
      assert.equal(session.shell.activeOrganization.id, native.organization.id);
    });
    await t.test("native sign-out revokes restoration; subsequent login expires after eight hours", async () => {
      const native = accounts[0];
      const logout = await request("sign-out", native.headers, {});
      assert.equal(logout.status, 200);
      assert.equal(logout.headers.get("set-cookie"), null);
      assert.equal((await (await request("session", native.headers)).json()).authenticated, false);
      const login = await request("sign-in", { "X-Biznoryx-Client": "mobile-v1" }, { email: native.email, password: native.password });
      assert.equal(login.status, 200);
      const token = (await login.json()).sessionToken;
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), "Sign-in returns a native credential.");
      const headers = { "X-Biznoryx-Client": "mobile-v1", Authorization: `Bearer ${token}` };
      assert.equal((await (await request("session", headers)).json()).authenticated, true);
      clock = new Date(clock.getTime() + 8 * 60 * 60 * 1000 + 1);
      const expired = await request("session", headers);
      assert.equal((await expired.json()).authenticated, false);
      assert.equal(expired.headers.get("set-cookie"), null);
      assert.equal((await request("organizations/switch", headers, { organizationId: native.organization.id })).status, 401);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
