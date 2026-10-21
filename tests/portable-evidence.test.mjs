import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPortableEvidenceFile } from "../src/reports/portable-evidence.mjs";
import { buildBusinessReport, buildReportCube } from "../src/reports/evidence-engine.mjs";
import { AuthError } from "../src/auth/core.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

function report() {
  const cube = buildReportCube({ rows: [{ date: "2026-01-01", revenue: "0.10" }, { date: "2026-01-31", revenue: "0.20" }] });
  return buildBusinessReport({ sources: [{ id: "source-a", seriesKey: "sales", fileName: "sales.csv", period: "2026-01",
    checksum: "a".repeat(64), confirmedAt: "2026-02-01T00:00:00Z", cube }], profile: { legalName: "Fictional business", primaryCurrency: "NGN" }, now: new Date("2026-02-01T00:00:00Z") });
}

test("portable evidence freezes exact observed values, source register and limitations", () => {
  const original = report();
  original.unexpectedPrivateField = "must not export";
  const file = createPortableEvidenceFile(original);
  assert.equal(file.payload.schemaVersion, "biznoryx.evidence-file.v1");
  assert.equal(file.payload.report.current.value, "0.3");
  assert.equal(file.payload.report.metric.currency, "NGN");
  assert.deepEqual(file.payload.report.evidence, original.evidence);
  assert.deepEqual(file.payload.report.limitations, original.limitations);
  assert.ok(file.payload.report.limitations.some(item => item.code === "MAPPING_UNCONFIRMED"));
  assert.equal(file.payload.report.metric.policy, null);
  assert.equal(file.payload.report.controls, undefined);
  assert.equal(file.payload.report.unexpectedPrivateField, undefined);
  assert.equal(file.payload.scope.originalFilesIncluded, false);
  assert.equal(file.payload.scope.actionsAndOutcomesIncluded, false);
  assert.equal(file.payload.scope.externalCertification, false);
  original.current.value = "999";
  assert.equal(file.payload.report.current.value, "0.3");
});

test("portable evidence digest is independently reproducible after JSON round trip", () => {
  const file = JSON.parse(JSON.stringify(createPortableEvidenceFile(report())));
  const digest = payload => createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  assert.equal(file.integrity.algorithm, "SHA-256");
  assert.equal(file.integrity.serialization, "JSON.stringify(payload)");
  assert.equal(file.integrity.value, digest(file.payload));
  assert.deepEqual(createPortableEvidenceFile(report()), file);
  file.payload.report.current.value = "1";
  assert.notEqual(file.integrity.value, digest(file.payload));
  assert.match(file.payload.scope.integrityLimitations, /not a digital signature/i);
});

test("production evidence file preserves tenant, premium and browser/native authentication boundaries", async () => {
  const token = "a".repeat(43), otherToken = "b".repeat(43);
  let paid = true;
  const calls = [];
  const cube = buildReportCube({ rows: [{ date: "2026-01-01", revenue: "0.10" }, { date: "2026-01-31", revenue: "0.20" }] });
  const { server } = createProductionApp({
    identityRepository: { async authenticate({ token: supplied }) {
      if (![token, otherToken].includes(supplied)) throw new AuthError("Session expired.", "SESSION_INVALID");
      const suffix = supplied === token ? "a" : "b";
      return { user: { id: `user-${suffix}` }, session: { activeOrganizationId: `org-${suffix}` } };
    } }, emailVerificationRepository: {}, production: false,
    billingRepository: { async ensureSubscription(context) {
      calls.push(context);
      return { status: paid ? "active" : "past_due", currentPeriodEnd: new Date(Date.now() + 86400000) };
    } },
    businessOnboardingRepository: { async getProfile() { return { primaryCurrency: "NGN" }; } },
    verifiedMetricsRepository: { async listSeries(context) {
      assert.equal(context.actorUserId, context.organizationId.replace("org-", "user-"));
      if (context.organizationId !== "org-a") return [];
      return cube.metrics.map(metric => ({ aggregation: "sum", sourceColumn: metric.column,
        dataStream: { id: "sales-a", displayName: "Sales" }, points: [{ id: "point-a", ingestionRunId: "run-a", periodStart: "2026-01-01", sourceRowCount: 2,
          createdAt: new Date("2026-02-01T00:00:00Z"), rawDataObjectId: "raw-a", evidence: { fileName: "private-a.csv", checksumSha256: "a".repeat(64), reportAnalytics: { metric } } }] }));
    } },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/evidence-report?format=json`;
  const browserHeaders = { cookie: `bnx_session=${token}` };
  try {
    assert.equal((await fetch(base)).status, 401);
    const response = await fetch(`${base}&organizationId=foreign&actorUserId=foreign`, { headers: browserHeaders });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const file = await response.json();
    assert.equal(file.payload.report.current.value, "0.3");
    assert.equal(file.payload.report.evidence.sources[0].fileName, "private-a.csv");
    assert.equal(calls.at(-1).organizationId, "org-a");
    const native = await fetch(base, { headers: { "x-biznoryx-client": "mobile-v1", authorization: `Bearer ${token}` } });
    assert.equal(native.status, 200);
    assert.equal((await native.json()).payload.report.current.value, "0.3");
    const foreign = await fetch(`${base}&source=run-a`, { headers: { cookie: `bnx_session=${otherToken}` } });
    assert.equal(foreign.status, 404);
    assert.doesNotMatch(await foreign.text(), /private-a\.csv|raw-a/);
    paid = false;
    assert.equal((await fetch(base, { headers: browserHeaders })).status, 402);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
