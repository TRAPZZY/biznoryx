import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

async function authRuntime(work) {
  const token = "a".repeat(43);
  const user = { id: "user-a", email: "owner@example.com", displayName: "Owner", emailVerifiedAt: new Date() };
  const state = { revoked: false, expired: false, activeOrganizationId: "org-a", authCalls: [], uploads: [], registrations: [] };
  const identity = {
    async createUser(input) { state.registrations.push(input); return user; },
    async createSessionForUser() { return identity.signIn({ requireVerifiedEmail: true }); },
    async signIn(input) {
      assert.equal(input.requireVerifiedEmail, true);
      if (input.password && input.password !== "StrongPassword2026!") throw new AuthError("Invalid credentials.", "INVALID_CREDENTIALS");
      state.revoked = false;
      return { user, session: { id: "session-a", userId: user.id, activeOrganizationId: state.activeOrganizationId }, token, csrfToken: "csrf", cookie: `bnx_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` };
    },
    async authenticate(input) {
      state.authCalls.push(input);
      if (input.token !== token || state.revoked || state.expired) throw new AuthError("Session is not active.", "SESSION_INVALID");
      if (input.requireCsrf && input.csrfToken !== "csrf") throw new AuthError("Invalid request protection.", "CSRF_INVALID");
      return { user, session: { id: "session-a", userId: user.id, activeOrganizationId: state.activeOrganizationId } };
    },
    async rotateCsrfToken() { return "csrf"; },
    async activeMemberships() { return [{ organizationId: "org-a", organizationName: "Business A", organizationSlug: "business-a", role: "owner" }]; },
    async switchOrganization({ organizationId }) {
      if (organizationId !== "org-a") throw new AuthError("Organization is not accessible.", "ORG_ACCESS_DENIED");
      state.activeOrganizationId = organizationId;
    },
    async revokeSession() { state.revoked = true; },
  };
  const { server } = createProductionApp({ identityRepository: identity, emailVerificationRepository: {
    async issue() { return { email: user.email }; },
    async verify({ code }) {
      if (code !== "12345678") throw new AuthError("Invalid code.", "EMAIL_CODE_INVALID");
      return user;
    },
  },
    billingRepository: { async ensureSubscription() { return { status: "active", currentPeriodEnd: "2099-01-01", provider: "paystack" }; } },
    ingestionService: { async upload(input) { state.uploads.push(input); throw new AuthError("Fixture stopped before persistence.", "VALIDATION_FAILED"); } },
    production: false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { body, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) => fetch(base + "/api/" + path, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try { await work({ request, token, state, base }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("native login returns bearer credential without cookie; expiry/logout invalidate restoration", async () => authRuntime(async ({ request, token, state }) => {
  const headers = { "x-biznoryx-client": "mobile-v1" };
  const login = await request("sign-in", { headers, body: { email: "owner@example.com", password: "StrongPassword2026!" } });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).sessionToken, token);
  assert.equal(login.headers.get("set-cookie"), null);
  headers.authorization = `Bearer ${token}`;
  assert.equal((await (await request("session", { headers })).json()).authenticated, true);
  const foreign = await request("organizations/switch", { headers, body: { organizationId: "org-b" } });
  assert.equal(foreign.status, 404);
  assert.equal(state.activeOrganizationId, "org-a");
  const logout = await request("sign-out", { headers, body: {} });
  assert.equal(logout.status, 200);
  assert.equal(state.authCalls.at(-1).requireCsrf, false);
  assert.equal((await (await request("session", { headers })).json()).authenticated, false);
}));

test("browser cookies retain CSRF checks and cannot request mobile tokens or bearer exemptions", async () => authRuntime(async ({ request, token, state, base }) => {
  const browserHeaders = { origin: base, "sec-fetch-site": "same-origin", "x-biznoryx-client": "mobile-v1" };
  const login = await request("sign-in", { headers: browserHeaders, body: { email: "owner@example.com", password: "StrongPassword2026!" } });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).sessionToken, undefined);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const missingCsrf = await request("organizations/switch", { headers: { ...browserHeaders, cookie: `bnx_session=${token}` }, body: { organizationId: "org-a" } });
  assert.equal(missingCsrf.status, 403);
  assert.equal(state.authCalls.at(-1).requireCsrf, true);
  const bearer = await request("organizations/switch", { headers: { ...browserHeaders, authorization: `Bearer ${token}` }, body: { organizationId: "org-a" } });
  assert.equal(bearer.status, 401);
  const crossSite = await request("sign-in", { headers: { origin: "https://another.example", "x-biznoryx-client": "mobile-v1" }, body: { email: "owner@example.com", password: "StrongPassword2026!" } });
  assert.equal(crossSite.status, 403);
}));

test("upload API selects the authenticated tenant, ignoring client organization override", async () => authRuntime(async ({ request, token, state }) => {
  const response = await request("ingestion/upload", { headers: { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` }, body: { organizationId: "org-b", fileName: "sales.csv", content: "date,revenue\n2026-10-01,10", period: "2026-10" } });
  assert.equal(response.status, 400);
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].organizationId, "org-a");
  assert.equal(state.uploads[0].actorUserId, "user-a");
  assert.equal(state.uploads[0].content, "date,revenue\n2026-10-01,10");
}));

test("native registration and email verification issue a protected credential for onboarding", async () => authRuntime(async ({ request, token, state }) => {
  const headers = { "x-biznoryx-client": "mobile-v1" };
  assert.equal((await request("session", { headers })).status, 200);
  const registered = await request("register", { headers, body: { email: "owner@example.com", displayName: "Owner", password: "StrongPassword2026!" } });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).requiresEmailVerification, true);
  assert.equal(state.registrations.length, 1);
  const invalid = await request("auth/verify-email", { headers, body: { email: "owner@example.com", code: "incorrect" } });
  assert.equal(invalid.status, 400);
  const verified = await request("auth/verify-email", { headers, body: { email: "owner@example.com", code: "12345678" } });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).sessionToken, token);
  assert.equal(verified.headers.get("set-cookie"), null);
  const switched = await request("organizations/switch", { headers: { ...headers, authorization: `Bearer ${token}` }, body: { organizationId: "org-a" } });
  assert.equal(switched.status, 200);
  assert.equal(state.authCalls.at(-1).requireCsrf, false);
}));

test("native requests reject bad credentials and never fall back to ambient cookies", async () => authRuntime(async ({ request, token }) => {
  const native = { "x-biznoryx-client": "mobile-v1", cookie: `bnx_session=${token}` };
  for (const authorization of [undefined, "Bearer invalid", `Bearer ${"b".repeat(43)}`]) {
    const response = await request("organizations/switch", { headers: { ...native, ...(authorization ? { authorization } : {}) }, body: { organizationId: "org-a" } });
    assert.equal(response.status, 401);
  }
  const valid = await request("organizations/switch", { headers: { ...native, authorization: `Bearer ${token}` }, body: { organizationId: "org-a" } });
  assert.equal(valid.status, 200);
  const badPassword = await request("sign-in", { headers: native, body: { email: "owner@example.com", password: "WrongPassword2026!" } });
  assert.equal(badPassword.status, 401);
  assert.equal((await badPassword.json()).sessionToken, undefined);
}));

test("expired native sessions cannot restore or mutate and never receive a cookie", async () => authRuntime(async ({ request, token, state }) => {
  state.expired = true;
  const headers = { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` };
  const restored = await request("session", { headers });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).authenticated, false);
  assert.equal(restored.headers.get("set-cookie"), null);
  assert.equal((await request("organizations/switch", { headers, body: { organizationId: "org-a" } })).status, 401);
}));

test("browser registration and verification keep cookie-only credentials and valid CSRF", async () => authRuntime(async ({ request, token, base }) => {
  const headers = { origin: base, "sec-fetch-site": "same-origin" };
  assert.equal((await request("register", { headers, body: { email: "owner@example.com", displayName: "Owner", password: "StrongPassword2026!" } })).status, 201);
  const verified = await request("auth/verify-email", { headers, body: { email: "owner@example.com", code: "12345678" } });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).sessionToken, undefined);
  assert.match(verified.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  headers.cookie = `bnx_session=${token}`;
  headers["x-csrf-token"] = "incorrect";
  assert.equal((await request("organizations/switch", { headers, body: { organizationId: "org-a" } })).status, 403);
  headers["x-csrf-token"] = "csrf";
  assert.equal((await request("organizations/switch", { headers, body: { organizationId: "org-a" } })).status, 200);
}));

test("native marker cannot bypass Origin or fetch metadata protections", async () => authRuntime(async ({ request, token, base }) => {
  for (const browser of [{ origin: "https://localhost" }, { origin: "https://another.example" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await request("register", { headers: { "x-biznoryx-client": "mobile-v1", ...browser }, body: { email: "owner@example.com", displayName: "Owner", password: "StrongPassword2026!" } });
    assert.equal(response.status, 403);
  }
  for (const browser of [{ origin: base }, { "sec-fetch-site": "same-origin" }]) {
    const response = await request("organizations/switch", { headers: { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}`, ...browser }, body: { organizationId: "org-a" } });
    assert.equal(response.status, 401);
  }
}));

test("native authentication does not enable Paystack purchase or management endpoints", async () => authRuntime(async ({ request, token }) => {
  for (const path of ["billing/checkout", "billing/verify", "billing/cancel", "billing/renew", "billing/trial/checkout", "billing/trial/verify", "billing/trial/cancel", "billing/trial/payment-update"]) {
    const response = await request(path, { headers: { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` }, body: {} });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, "Manage this subscription through Apple or Google.");
    assert.equal((await request(path, { headers: { "x-biznoryx-client": "mobile-v1" }, body: {} })).status, 401);
  }
}));
