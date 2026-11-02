import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPerformanceFindingsRepository } from "../src/database/performance-findings-repository.mjs";

const comparison = {
  comparison_id: "comparison", organization_id: "organization",
  metric_definition_id: "metric", current_reporting_period_id: "february",
  previous_reporting_period_id: "january", current_metric_point_id: "current",
  previous_metric_point_id: "previous", comparison_status: "ready", direction: "up",
  metric_key: "sum:revenue", metric_label: "Revenue", source_column: "revenue",
  aggregation: "sum", unit: "number", data_stream_id: "stream-uuid",
  previous_value_numeric: "100.0000000000", current_value_numeric: "125.0000000000",
  absolute_change_numeric: "25.0000000000", percent_change_numeric: "25.0000000000",
  comparison_evidence: { currentRawDataObjectId: "raw-current", previousRawDataObjectId: "raw-previous" },
};

const policy = {
  id: "policy-id", series_key: "stream-uuid", source_column: "revenue", version: 2,
  label: "Recorded receipts", unit: "currency", polarity: "lower", materiality_percent: "5.000",
  approved_at: "2026-11-02T12:00:00.000Z", approved_by_user_id: "owner",
};

function fixture({ rows = [comparison], policies = [], schema = true, policyError } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("from verified_metric_comparisons c")) return { rows };
      if (sql.includes("to_regclass")) return { rows: [{ available: schema }] };
      if (sql.includes("from evidence_report_definitions")) {
        if (policyError) throw policyError;
        return { rows: policies };
      }
      if (sql.includes("insert into verified_performance_findings")) {
        return { rows: [{ organization_id: params[0], source_comparison_id: params[1],
          metric_definition_id: params[2], current_reporting_period_id: params[3],
          finding_type: params[4], severity: params[5], title: params[6], summary: params[7],
          evidence: JSON.parse(params[8]), status: "active" }] };
      }
      return { rows: [] };
    },
    release() { queries.push({ sql: "release" }); },
  };
  return { queries, repository: new PostgresPerformanceFindingsRepository({ connect: async () => client }) };
}

async function refresh(f) {
  return f.repository.refreshForIngestion({ organizationId: "organization", ingestionRunId: "ingestion" });
}

test("unapproved revenue increases remain verified measurements with unconfirmed business meaning", async () => {
  const findings = await refresh(fixture());
  assert.deepEqual(findings.map((f) => f.findingType), ["signal", "focus_area"]);
  for (const finding of findings) {
    assert.equal(finding.evidence.metricPolarity, "neutral");
    assert.equal(finding.evidence.interpretationStatus, "unconfirmed");
    assert.match(finding.summary, /interpretation is unconfirmed/i);
    assert.equal(finding.evidence.previousValue, "100");
    assert.equal(finding.evidence.currentValue, "125");
    assert.equal(finding.evidence.absoluteChange, "25");
    assert.equal(finding.evidence.percentChange, "25");
    assert.equal(finding.evidence.currentRawDataObjectId, "raw-current");
  }
});

test("unapproved decreases and cost headers remain neutral too", async () => {
  for (const column of ["cost", "revenue", "balance"]) {
    const findings = await refresh(fixture({ rows: [{ ...comparison,
      source_column: column, metric_key: `sum:${column}`, direction: "down",
      previous_value_numeric: "125", current_value_numeric: "100",
      absolute_change_numeric: "-25", percent_change_numeric: "-20",
    }] }));
    assert.deepEqual(findings.map((finding) => finding.findingType), ["signal", "focus_area"]);
    assert.equal(findings[0].evidence.metricPolarity, "neutral");
    assert.equal(findings[0].evidence.direction, "down");
    assert.equal(findings[0].evidence.absoluteChange, "-25");
  }
});

test("approved higher and lower definitions assess both measured directions", async () => {
  for (const [polarity, direction, type] of [
    ["higher", "up", "opportunity"], ["higher", "down", "risk"],
    ["lower", "up", "risk"], ["lower", "down", "opportunity"],
  ]) {
    const movement = direction === "up" ? comparison : { ...comparison,
      previous_value_numeric: "125", current_value_numeric: "100",
      absolute_change_numeric: "-25", percent_change_numeric: "-20" };
    const findings = await refresh(fixture({ rows: [{ ...movement, direction }],
      policies: [{ ...policy, polarity }] }));
    assert.equal(findings.at(-1).findingType, type);
    assert.equal(findings.at(-1).evidence.semanticRule, "approved_evidence_report_definition_v1");
  }
});

test("approved direction overrides the header and pins the exact report policy provenance", async () => {
  const f = fixture({ policies: [policy] });
  const findings = await refresh(f);
  assert.deepEqual(findings.map((f) => f.findingType), ["signal", "focus_area", "risk"]);
  for (const finding of findings) {
    assert.equal(finding.evidence.metricPolarity, "lower_is_better");
    assert.equal(finding.evidence.interpretationStatus, "approved");
    assert.equal(finding.evidence.policyStatus, "approved");
    assert.deepEqual(finding.evidence.metricPolicy, {
      id: "policy-id", seriesKey: "stream-uuid", column: "revenue", version: 2,
      label: "Recorded receipts", unit: "currency", polarity: "lower", materialityPercent: 5,
      approvedAt: policy.approved_at, approvedByUserId: "owner",
    });
    assert.match(finding.title, /Recorded receipts/);
    assert.match(finding.summary, /approved metric definition v2/);
  }
  const lookup = f.queries.find((q) => q.sql.includes("from evidence_report_definitions"));
  assert.deepEqual(lookup.params, ["organization", ["stream-uuid"]]);
});

test("explicit approved neutral policy never falls back to revenue header semantics", async () => {
  const findings = await refresh(fixture({ policies: [{ ...policy, polarity: "neutral" }] }));
  assert.deepEqual(findings.map((f) => f.findingType), ["signal", "focus_area"]);
  assert.equal(findings[0].evidence.metricPolarity, "neutral");
  assert.equal(findings[0].evidence.interpretationStatus, "approved");
  assert.match(findings[0].summary, /approved metric definition is neutral/i);
});

test("approved policy cannot bind to another stream, column or aggregation", async () => {
  for (const row of [
    { ...comparison, data_stream_id: "another-stream" },
    { ...comparison, source_column: "Revenue" },
    { ...comparison, aggregation: "average" },
  ]) {
    const findings = await refresh(fixture({ rows: [row], policies: [policy] }));
    assert.deepEqual(findings.map((f) => f.findingType), ["signal", "focus_area"]);
    assert.equal(findings[0].evidence.metricPolarity, "neutral");
    assert.equal(findings[0].evidence.metricPolicy, null);
  }
});

test("policy materiality gates directional findings while keeping measured changes", async () => {
  for (const [percent, expected] of [["24.999", 2], ["25", 3]]) {
    const findings = await refresh(fixture({
      rows: [{ ...comparison, percent_change_numeric: percent }],
      policies: [{ ...policy, materiality_percent: "25" }],
    }));
    assert.equal(findings.length, expected);
    assert.equal(findings[0].evidence.percentChange, percent);
  }
  const zero = await refresh(fixture({ rows: [{ ...comparison, direction: "flat",
    absolute_change_numeric: "0", percent_change_numeric: "0" }], policies: [policy] }));
  assert.equal(zero.length, 2);
  const noBaseline = await refresh(fixture({ rows: [{ ...comparison,
    previous_value_numeric: "0", absolute_change_numeric: "125", percent_change_numeric: null }],
    policies: [policy] }));
  assert.equal(noBaseline.at(-1).findingType, "risk");
  assert.equal(noBaseline[0].evidence.percentChange, null);
});

test("missing optional schema is an explicit neutral capability boundary", async () => {
  const f = fixture({ schema: false });
  const findings = await refresh(f);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].evidence.policyStatus, "schema_unavailable");
  assert.equal(findings[0].evidence.interpretationStatus, "unconfirmed");
  assert.equal(f.queries.some((q) => q.sql.includes("from evidence_report_definitions")), false);
  assert.equal(f.queries.some((q) => q.sql === "commit"), true);
});

test("installed-schema permission and SQL failures abort before findings mutate", async () => {
  for (const code of ["42501", "42703", "42P01"]) {
    const failure = Object.assign(new Error("policy lookup failed"), { code });
    const f = fixture({ policyError: failure });
    await assert.rejects(refresh(f), (error) => error === failure);
    assert.equal(f.queries.some((q) => q.sql === "rollback"), true);
    assert.equal(f.queries.some((q) => q.sql === "commit"), false);
    assert.equal(f.queries.some((q) => /delete from|insert into/.test(q.sql)), false);
    assert.equal(f.queries.at(-1).sql, "release");
  }
});

test("neutral refresh removes obsolete directional findings and retains not-ready cleanup", async () => {
  const f = fixture();
  await refresh(f);
  const deletion = f.queries.find((q) => q.sql.includes("delete from verified_performance_findings"));
  assert.deepEqual(deletion.params, ["organization", "metric", "february", ["signal", "focus_area"]]);
  const notReady = fixture({ rows: [{ ...comparison, comparison_status: "not_ready" }] });
  assert.deepEqual(await refresh(notReady), []);
  assert.equal(notReady.queries.some((q) => q.sql.includes("to_regclass")), false);
  assert.ok(notReady.queries.some((q) => q.sql.includes("delete from verified_performance_findings")));
});
