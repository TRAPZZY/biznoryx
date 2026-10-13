import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

async function authRuntime(work) {
  const token = "a".repeat(43);
  const user = { id: "user-a", email: "owner@example.com", displayName: "Owner", emailVerifiedAt: new Date() };
  const state = { revoked: false, activeOrganizationId: "org-a", authCalls: [], uploads: [] };
  const identity = {
    async signIn(input) {
      assert.equal(input.requireVerifiedEmail, true);
      state.revoked = false;
      return { user, session: { id: "session-a", userId: user.id, activeOrganizationId: state.activeOrganizationId }, token, csrfToken: "csrf", cookie: `bnx_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` };
    },
    async authenticate(input) {
      state.authCalls.push(input);
      if (input.token !== token || state.revoked) throw new AuthError("Session is not active.", "SESSION_INVALID");
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
  const { server } = createProductionApp({ identityRepository: identity, emailVerificationRepository: {},
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

test("upload API forwards PDF payloads with server-selected tenant, ignoring client organization override", async () => authRuntime(async ({ request, token, state }) => {
  const response = await request("ingestion/upload", { headers: { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` }, body: { organizationId: "org-b", fileName: "report.pdf", contentBase64: "JVBERi0=", period: "2026-10" } });
  assert.equal(response.status, 400);
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].organizationId, "org-a");
  assert.equal(state.uploads[0].actorUserId, "user-a");
  assert.equal(state.uploads[0].contentBase64, "JVBERi0=");
}));
