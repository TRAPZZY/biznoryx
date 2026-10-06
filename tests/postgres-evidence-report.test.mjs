import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool, withTenantTransaction } from "../src/database/postgres.mjs";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresEvidenceReportRepository } from "../src/database/evidence-report-repository.mjs";
import { AuthError } from "../src/auth/core.mjs";
import { buildReportCube } from "../src/reports/evidence-engine.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

test("PostgreSQL report mappings survive reload, version approvals and enforce tenant/read-only isolation", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test" });
  const identity = new PostgresIdentityRepository(pool, { production: false });
  const reports = new PostgresEvidenceReportRepository(pool);
  const suffix = randomUUID();
  const definition = { label: "Revenue", unit: "currency", polarity: "higher", materialityPercent: 5,
    revenueBreakdown: { productColumn: "product", quantityColumn: "quantity", quantityUnit: "items", currency: "NGN", confirmed: true } };
  try {
    const owner = await identity.createUser({ email: `report-owner-${suffix}@example.com`, displayName: "Report Owner", password: "EvidenceOwnerPassphrase2026!" });
    const outsider = await identity.createUser({ email: `report-other-${suffix}@example.com`, displayName: "Report Outsider", password: "EvidenceOtherPassphrase2026!" });
    const viewer = await identity.createUser({ email: `report-viewer-${suffix}@example.com`, displayName: "Report Viewer", password: "EvidenceViewerPassphrase2026!" });
    const org = await identity.createOrganization({ actorUserId: owner.id, name: "Evidence Org", slug: `report-${suffix}` });
    const otherOrg = await identity.createOrganization({ actorUserId: outsider.id, name: "Other Evidence Org", slug: `other-${suffix}` });
    const tenant = { organizationId: org.id, actorUserId: owner.id };
    await withTenantTransaction(pool, tenant, (client) => client.query("insert into organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'viewer', 'active')", [org.id, viewer.id]));
    const input = { ...tenant, seriesKey: "sales-stream", column: "revenue", definition, expectedVersion: 0 };
    const first = await reports.approvePolicy(input);
    assert.equal(first.version, 1);
    const reloaded = await new PostgresEvidenceReportRepository(pool).listPolicies(tenant);
    assert.deepEqual(reloaded[0].revenueBreakdown, definition.revenueBreakdown);
    await assert.rejects(reports.approvePolicy(input), /changed/);
    const second = await reports.approvePolicy({ ...input, expectedVersion: 1, definition: { ...definition, revenueBreakdown: null } });
    assert.equal(second.version, 2);
    assert.equal(second.revenueBreakdown, null);
    const old = await withTenantTransaction(pool, tenant, (client) => client.query("select revenue_breakdown from evidence_report_definitions where organization_id=$1 and version=1", [org.id]));
    assert.deepEqual(old.rows[0].revenue_breakdown, definition.revenueBreakdown);
    const visible = await reports.listPolicies({ organizationId: org.id, actorUserId: viewer.id });
    assert.equal(visible.length, 1);
    await assert.rejects(reports.approvePolicy({ ...input, actorUserId: viewer.id, expectedVersion: 2 }), /access denied/i);
    await assert.rejects(reports.listPolicies({ organizationId: org.id, actorUserId: outsider.id }), /access denied/i);
    assert.deepEqual(await reports.listPolicies({ organizationId: otherOrg.id, actorUserId: outsider.id }), []);
    const direct = await withTenantTransaction(pool, { organizationId: otherOrg.id, actorUserId: outsider.id }, (client) => client.query("select id from evidence_report_definitions where organization_id=$1", [org.id]));
    assert.equal(direct.rowCount, 0);
    await assert.rejects(withTenantTransaction(pool, tenant, (client) => client.query("insert into evidence_report_definitions (organization_id,series_key,source_column,version,label,unit,polarity,materiality_percent,approved_by_user_id,revenue_breakdown) values ($1,'bad','revenue',1,'Revenue','currency','higher',5,$2,$3::jsonb)", [org.id, owner.id, JSON.stringify({ ...definition.revenueBreakdown, confirmed: null })])), /check constraint/i);
    const parallel = await Promise.allSettled([
      reports.approvePolicy({ ...input, expectedVersion: 2 }),
      reports.approvePolicy({ ...input, expectedVersion: 2 }),
    ]);
    assert.equal(parallel.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await reports.listPolicies(tenant))[0].version, 3);
    const cube = buildReportCube({ rows: [
      { date: "2026-01-01", product: "A", quantity: "5", revenue: "50" },
      { date: "2026-01-31", product: "B", quantity: "5", revenue: "100" },
      { date: "2026-02-01", product: "A", quantity: "8", revenue: "96" },
      { date: "2026-02-28", product: "B", quantity: "4", revenue: "72" },
    ] });
    let actor = owner, organizationId = org.id, paid = true;
    const app = createProductionApp({
      identityRepository: { async authenticate({ requireCsrf, csrfToken }) {
        if (requireCsrf && csrfToken !== "csrf-test") throw new AuthError("Invalid CSRF token.", "CSRF_INVALID");
        return { user: actor, session: { activeOrganizationId: organizationId } };
      } },
      emailVerificationRepository: {}, evidenceReportRepository: reports,
      billingRepository: { async ensureSubscription() { return { status: paid ? "active" : "past_due", currentPeriodEnd: new Date(Date.now() + 86400000) }; } },
      businessOnboardingRepository: { async getProfile(context) { assert.equal(context.organizationId, organizationId); return { primaryCurrency: "NGN" }; } },
      verifiedMetricsRepository: { async listSeries(context) {
        assert.equal(context.organizationId, organizationId);
        assert.equal(context.actorUserId, actor.id);
        if (organizationId !== org.id) return [];
        return cube.metrics.map((metric) => ({ aggregation: "sum", sourceColumn: metric.column, dataStream: { id: "sales-stream", displayName: "Sales" }, points: [{ id: `point-${metric.column}`, ingestionRunId: "run-http", periodStart: "2026-02-01", sourceRowCount: 4, createdAt: new Date(), rawDataObjectId: "raw-http", evidence: { fileName: "sales.csv", checksumSha256: "a".repeat(64), reportAnalytics: { schemaFingerprint: cube.schemaFingerprint, metric } } }] }));
      } }, production: false,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api/evidence-report`;
    const post = (body, csrf = true) => fetch(`${base}/definition`, { method: "POST", headers: { cookie: "bnx_session=test", "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": "csrf-test" } : {}) }, body: JSON.stringify(body) });
    const approval = { ...definition, source: "run-http", metric: "revenue", expectedVersion: 3 };
    try {
      const beforeApproval = await fetch(base, { headers: { cookie: "bnx_session=test" } });
      assert.equal(beforeApproval.status, 200);
      const report = (await beforeApproval.json()).report;
      assert.equal(report.revenueBreakdown.status, "ready");
      assert.equal(report.revenueBreakdown.evidence.sources[0].quantityMetricPointId, "point-quantity");
      assert.equal(report.explainer.scope.mappingVersion, 3);
      assert.equal((await post(approval, false)).status, 403);
      assert.equal((await post({ ...approval, revenueBreakdown: { ...definition.revenueBreakdown, quantityColumn: "missing" } })).status, 400);
      const saved = await post(approval);
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal((await saved.json()).policy.version, 4);
      actor = viewer;
      assert.equal((await post({ ...approval, expectedVersion: 4 })).status, 404);
      assert.equal((await fetch(base, { headers: { cookie: "bnx_session=test" } })).status, 200);
      actor = outsider; organizationId = otherOrg.id;
      assert.equal((await post({ ...approval, expectedVersion: 4 })).status, 404);
      assert.equal((await (await fetch(base, { headers: { cookie: "bnx_session=test" } })).json()).report, null);
      actor = owner; organizationId = org.id; paid = false;
      assert.equal((await post({ ...approval, expectedVersion: 4 })).status, 402);
    } finally {
      app.server.closeAllConnections?.();
      await new Promise((resolve) => app.server.close(resolve));
    }
  } finally { await pool.end(); }
});
