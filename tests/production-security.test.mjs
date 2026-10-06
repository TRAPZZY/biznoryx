import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

async function withServer(options, work) {
  const { server } = createProductionApp({
    identityRepository: {},
    emailVerificationRepository: {},
    production: false,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await work(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTPS redirects keep the configured application origin for hostile request targets", async () => {
  const previousUrl = process.env.BIZNORYX_PUBLIC_URL;
  process.env.BIZNORYX_PUBLIC_URL = "https://biznoryx.example";
  try {
    await withServer({ production: true }, async (port) => {
      for (const target of ["//attacker.example/account?x=1", "http://attacker.example/account?x=1", "/account?x=1"]) {
        const response = await request(port, target, { headers: { "x-forwarded-proto": "http" } });
        assert.equal(response.status, 308);
        const destination = new URL(response.headers.location);
        assert.equal(destination.origin, "https://biznoryx.example", target);
        assert.equal(destination.search, "?x=1");
      }
    });
  } finally {
    if (previousUrl === undefined) delete process.env.BIZNORYX_PUBLIC_URL;
    else process.env.BIZNORYX_PUBLIC_URL = previousUrl;
  }
});

test("production browser writes validate the full configured origin behind a proxy", async () => {
  const previousUrl = process.env.BIZNORYX_PUBLIC_URL;
  process.env.BIZNORYX_PUBLIC_URL = "https://biznoryx.example";
  let issued = 0;
  try {
    await withServer({ production: true, emailVerificationRepository: { async issue({ email }) { issued += 1; return { email }; } } }, async (port) => {
      for (const origin of ["http://biznoryx.example", "https://attacker.example", "null"]) {
        const response = await request(port, "/api/auth/resend-code", {
          method: "POST",
          headers: { host: "biznoryx.example", origin },
          body: JSON.stringify({ email: "owner@example.test" }),
        });
        assert.equal(response.status, 403, origin);
      }
      const allowed = await request(port, "/api/auth/resend-code", {
        method: "POST",
        headers: { host: "internal-service:4175", origin: "https://biznoryx.example" },
        body: JSON.stringify({ email: "owner@example.test" }),
      });
      assert.equal(allowed.status, 200);
      const crossSite = await request(port, "/api/auth/resend-code", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ email: "owner@example.test" }),
      });
      assert.equal(crossSite.status, 403);
      assert.equal(issued, 1);
    });
  } finally {
    if (previousUrl === undefined) delete process.env.BIZNORYX_PUBLIC_URL;
    else process.env.BIZNORYX_PUBLIC_URL = previousUrl;
  }
});

test("authentication rejects oversized declared and chunked bodies before email delivery", async () => {
  let issued = 0;
  await withServer({ emailVerificationRepository: { async issue({ email }) { issued += 1; return { email }; } } }, async (port) => {
    const body = JSON.stringify({ email: "owner@example.test", padding: "x".repeat(70_000) });
    for (const headers of [{ "content-length": Buffer.byteLength(body) }, { "transfer-encoding": "chunked" }]) {
      const response = await request(port, "/api/auth/resend-code", { method: "POST", headers, body });
      assert.equal(response.status, 413);
      assert.equal(JSON.parse(response.body).error, "PAYLOAD_TOO_LARGE");
    }
    assert.equal(issued, 0);
    const allowed = await request(port, "/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email: "owner@example.test" }) });
    assert.equal(allowed.status, 200);
    assert.equal(issued, 1);
  });
});

test("authenticated CSV uploads retain their larger request allowance", async () => {
  const content = "amount\n" + "100\n".repeat(20_000);
  let uploaded = false;
  await withServer({
    identityRepository: { async authenticate({ requireCsrf }) {
      assert.equal(requireCsrf, true);
      return { user: { id: "user-1" }, session: { activeOrganizationId: "org-1" } };
    } },
    billingRepository: { async ensureSubscription() { return { status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) }; } },
    ingestionService: { async upload(input) {
      assert.equal(input.content, content);
      assert.equal(input.organizationId, "org-1");
      uploaded = true;
      throw new AuthError("Upload reached validation.", "VALIDATION_FAILED");
    } },
  }, async (port) => {
    const response = await request(port, "/api/ingestion/upload", {
      method: "POST",
      headers: { cookie: "bnx_session=test-token", "x-csrf-token": "test-csrf" },
      body: JSON.stringify({ fileName: "sales.csv", content, period: "2026-09" }),
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).message, "Upload reached validation.");
    assert.equal(uploaded, true);
  });
});

test("viewers cannot start, verify or complete billing checkout", async () => {
  let billingCalls = 0;
  await withServer({
    identityRepository: {
      async authenticate() { return { user: { id: "viewer-1" }, session: { activeOrganizationId: "org-1" } }; },
      async activeMemberships() { return [{ organizationId: "org-1", role: "viewer" }]; },
    },
    billingRepository: { async ensureSubscription() { billingCalls += 1; return { status: "non_renewing" }; } },
  }, async (port) => {
    for (const path of ["/api/billing/checkout", "/api/billing/verify", "/billing/paystack/callback?reference=test-reference"]) {
      const response = await request(port, path, {
        method: path.startsWith("/api/") ? "POST" : "GET",
        headers: { cookie: "bnx_session=test-token", "x-csrf-token": "test-csrf" },
        body: path.startsWith("/api/") ? JSON.stringify({ reference: "test-reference" }) : "",
      });
      assert.equal(response.status, 404, path);
      assert.equal(JSON.parse(response.body).error, "ORG_ACCESS_DENIED");
    }
    assert.equal(billingCalls, 0);
  });
});

test("one account cannot exhaust another account's authentication allowance behind a shared proxy", async () => {
  await withServer({ emailVerificationRepository: { async issue({ email }) { return { email }; } } }, async (port) => {
    for (let index = 0; index < 15; index += 1) {
      const response = await request(port, "/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email: "one@example.test" }) });
      assert.equal(response.status, 200);
    }
    const blocked = await request(port, "/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email: "ONE@example.test" }) });
    assert.equal(blocked.status, 429);
    const other = await request(port, "/api/auth/resend-code", { method: "POST", body: JSON.stringify({ email: "two@example.test" }) });
    assert.equal(other.status, 200);
  });
});

test("cross-site session navigation cannot rotate a session's CSRF token", async () => {
  let authenticated = false;
  await withServer({ identityRepository: { async authenticate() { authenticated = true; } } }, async (port) => {
    const response = await request(port, "/api/session", { headers: { cookie: "bnx_session=test-token", "sec-fetch-site": "cross-site" } });
    assert.equal(response.status, 403);
    assert.equal(authenticated, false);
  });
});
