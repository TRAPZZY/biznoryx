import test from "node:test";
import assert from "node:assert/strict";
import { buildReportCube, buildBusinessReport } from "../src/reports/evidence-engine.mjs";
import { reportSourcesFromSeries } from "../src/reports/production-sources.mjs";

const rows = [
  { order_date: "2025-01-01", year: "2025", channel: "Online", revenue: "100.10", cost: "40", margin_percent: "60" },
  { order_date: "2025-01-31", year: "2025", channel: "Store", revenue: "99.90", cost: "60", margin_percent: "40" },
  { order_date: "2025-02-01", year: "2025", channel: "Online", revenue: "160", cost: "90", margin_percent: "44" },
  { order_date: "2025-02-28", year: "2025", channel: "Store", revenue: "80", cost: "70", margin_percent: "13" },
  { order_date: "2025-03-01", year: "2025", channel: "Online", revenue: "210", cost: "100", margin_percent: "52" },
  { order_date: "2025-03-31", year: "2025", channel: "Store", revenue: "90", cost: "80", margin_percent: "11" },
];
function source(data = rows, extra = {}) {
  return { id: "upload-a", seriesKey: "sales", fileName: "sales.csv", period: "2026-09", checksum: "a".repeat(64), confirmedAt: "2026-09-28T12:00:00Z", cube: buildReportCube({ rows: data, columns: Object.keys(data[0]) }), ...extra };
}
function report(options = {}, sources = [source()], policies = []) {
  return buildBusinessReport({ sources, profile: { legalName: "Test business", primaryCurrency: "USD" }, options, policies });
}

test("actual row dates produce three periods from one file; calendar and rate columns are not summed", () => {
  const result = report({ metric: "revenue" });
  assert.deepEqual(result.timeline.map((p) => p.period), ["2025-01", "2025-02", "2025-03"]);
  assert.deepEqual(result.timeline.map((p) => p.value), ["200", "240", "300"]);
  assert.equal(result.current.period, "2025-03");
  assert.equal(result.comparison.percentChange, 25);
  assert.ok(!result.controls.metrics.some((m) => /year|percent/.test(m.column)));
  assert.ok(result.limitations.some((l) => l.code === "DECLARED_PERIOD_MISMATCH"));
});

test("dimension contribution reconciles exactly with movement, including new and lost categories", () => {
  const result = report({ metric: "revenue", period: "2025-02", dimension: "channel" });
  assert.equal(result.drivers.reconciled, true);
  assert.equal(result.drivers.totalChange, "40");
  assert.deepEqual(result.drivers.entries.map((e) => [e.name, e.change]), [["Online", "59.9"], ["Store", "-19.9"]]);
});

test("unknown metric polarity never manufactures a strength or deterioration", () => {
  const result = report({ metric: "revenue" });
  assert.equal(result.health, "insufficient_evidence");
  assert.equal(result.strengths.length, 0);
  assert.ok(result.limitations.some((l) => l.code === "MAPPING_UNCONFIRMED"));
  assert.match(result.executive.focus, /Online records/);
  assert.doesNotMatch(result.executive.focus, /Confirm the metric/i);
});

test("approved cost polarity evaluates rising costs as adverse", () => {
  const result = report({ metric: "cost", period: "2025-02" }, [source()], [{ seriesKey: "sales", column: "cost", version: 1, polarity: "lower", materialityPercent: 5, label: "Operating cost", approvedAt: "2026-09-28T00:00:00Z" }]);
  assert.equal(result.health, "deteriorating");
  assert.ok(result.priorities.some((p) => p.quadrant === "fix_first"));
});

test("three contiguous favorable complete periods are needed for a persistent strength", () => {
  const policies = [{ seriesKey: "sales", column: "revenue", version: 1, polarity: "higher", materialityPercent: 5, label: "Revenue", approvedAt: "2026-09-28T00:00:00Z" }];
  assert.equal(report({ metric: "revenue" }, [source()], policies).strengths.length, 1);
  assert.equal(report({ metric: "revenue", period: "2025-02" }, [source()], policies).strengths.length, 0);
});

test("zero denominators, missing dates and missing amounts remain explicit", () => {
  const data = [{ date: "2025-01-01", amount: "0" }, { date: "2025-02-28", amount: "20" }, { date: "2025-02-30", amount: "" }];
  const result = report({ metric: "amount" }, [source(data)]);
  assert.equal(result.comparison.percentChange, null);
  assert.ok(result.limitations.some((l) => l.code === "INVALID_DATES"));
  assert.ok(result.limitations.some((l) => l.code === "MISSING_METRIC"));
  assert.equal(result.drivers, null);
});

test("identical and overlapping uploads cannot masquerade as recurring growth", () => {
  const a = source();
  const result = report({ metric: "revenue" }, [a, { ...a, id: "upload-b", period: "2026-10" }, source(rows.slice(2), { id: "upload-c", checksum: "b".repeat(64) })]);
  assert.equal(result.current.value, "300");
  assert.ok(result.limitations.some((l) => l.code === "DUPLICATE_SOURCE"));
  assert.ok(result.limitations.some((l) => l.code === "OVERLAPPING_SOURCE"));
});

test("period and metric selections change both narrative and data without future evidence", () => {
  const result = report({ metric: "revenue", period: "2025-02", compare: "2025-01" });
  assert.equal(result.current.value, "240");
  assert.equal(result.comparison.percentChange, 20);
  assert.equal(result.timeline.at(-1).period, "2025-02");
  assert.throws(() => report({ metric: "revenue", period: "2025-01", compare: "2025-03" }), /earlier/i);
});

test("report contains source lineage and version but never raw transaction rows", () => {
  const result = report({ metric: "revenue" });
  assert.equal(result.version, "evidence-v2");
  assert.equal(result.evidence.sources[0].checksum, "a".repeat(64));
  assert.equal(result.evidence.calculation, "sum(revenue)");
  assert.equal(result.evidence.dateColumn, "order_date");
  assert.equal(result.rows, undefined);
});

test("production verified metric series preserve report analytics and default to the primary measure", () => {
  const cube = buildReportCube({ rows, columns: Object.keys(rows[0]) });
  const point = {
    id: "metric-point-1",
    ingestionRunId: "run-1",
    rawDataObjectId: "raw-1",
    reportingPeriodId: "period-1",
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    periodLabel: "Mar 2025",
    value: "300",
    contributingRowCount: 6,
    sourceRowCount: 6,
    createdAt: "2026-09-28T12:00:00Z",
    evidence: {
      fileName: "sales.csv",
      checksumSha256: "b".repeat(64),
      reportAnalytics: {
        schemaFingerprint: cube.schemaFingerprint,
        omittedDimensions: cube.omittedDimensions,
        metric: cube.metrics.find((metric) => metric.column === "revenue"),
      },
    },
  };
  const sources = reportSourcesFromSeries([
    { metricKey: "sum:quantity", label: "Quantity", sourceColumn: "quantity", aggregation: "sum", unit: "number", dataStream: { id: "sales", displayName: "Sales" }, points: [{ ...point, id: "metric-point-quantity", value: "12", evidence: { ...point.evidence, reportAnalytics: null } }] },
    { metricKey: "sum:revenue", label: "Revenue", sourceColumn: "revenue", aggregation: "sum", unit: "currency", dataStream: { id: "sales", displayName: "Sales" }, points: [point] },
    { metricKey: "sum:year", label: "Year", sourceColumn: "year", aggregation: "sum", unit: "number", dataStream: { id: "sales", displayName: "Sales" }, points: [point] },
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].cube.metrics[0].column, "revenue");
  assert.equal(sources[0].cube.metrics.some((metric) => metric.column === "year"), false);
  assert.equal(sources[0].rawDataObjectId, "raw-1");
  assert.equal(sources[0].metricPointIds.revenue, "metric-point-1");
});

test("report construction rejects oversized dimension headers before reading row values", () => {
  const column = "product_" + "x".repeat(4096);
  const row = { get revenue() { assert.fail("Rows must not be analyzed with oversized headers"); } };
  assert.throws(() => buildReportCube({ rows: [row], columns: [column, "revenue"] }),
    { code: "VALIDATION_FAILED", message: /160 UTF-8 bytes/ });
});

test("analytics budget includes repeated category values across months and metrics", () => {
  // Escaped control characters cost six JSON bytes each. Each metric fits alone,
  // but their combined repeated dimensions exceed the source-wide budget.
  const data = Array.from({ length: 120 }, (_, i) => ({
    date: `${2020 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}-01`,
    product: `${i % 2 ? "A" : "B"}${"\u0001".repeat(4096)}`,
    revenue: "1", cost: "2", quantity: "3", amount: "4",
  }));
  const single = buildReportCube({ rows: data, columns: ["date", "product", "revenue"] });
  assert.equal(single.metrics[0].all.value, "120");
  assert.equal(single.metrics[0].dates[0].months.length, 120);
  assert.ok(Buffer.byteLength(JSON.stringify(single)) < 8 * 1024 * 1024);
  assert.throws(() => buildReportCube({ rows: data }),
    { code: "VALIDATION_FAILED", message: /8 MB size budget/ });
});

test("analytics budget bounds a single oversized category before bucket serialization", () => {
  const data = [
    { product: "é".repeat(750000), revenue: "1" },
    { product: "B", revenue: "2" },
  ];
  assert.throws(() => buildReportCube({ rows: data }),
    { code: "VALIDATION_FAILED", message: /8 MB size budget/ });
});
