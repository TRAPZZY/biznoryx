import assert from "node:assert/strict";
import test from "node:test";
import { buildReportCube, buildBusinessReport, parseReportNumber, validateReportPolicy, validateRevenueMappingSource } from "../src/reports/evidence-engine.mjs";
import { renderReportHtml, renderReportCsv, renderReportPdf } from "../src/reports/export.mjs";
import { parse } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import { buildRevenueBreakdown } from "../src/reports/revenue-breakdown.mjs";
import { reportValue } from "../web-app/evidence-report.js";

export function salesSource(rows, extra = {}) {
  return { id: "sales-source", seriesKey: "sales-series", fileName: "sales.csv", period: "2026-02",
    checksum: "a".repeat(64), confirmedAt: "2026-10-06T00:00:00Z",
    cube: buildReportCube({ rows }), ...extra };
}

export const salesRows = [
  { date: "2026-01-01", product: "A", quantity: "5", revenue: "50" },
  { date: "2026-01-31", product: "B", quantity: "5", revenue: "100" },
  { date: "2026-02-01", product: "A", quantity: "8", revenue: "96" },
  { date: "2026-02-28", product: "B", quantity: "4", revenue: "72" },
];

export function salesPolicy(extra = {}) {
  return { seriesKey: "sales-series", column: "revenue", version: 1, label: "Revenue", unit: "currency",
    polarity: "higher", materialityPercent: 5, approvedAt: "2026-10-06T00:00:00Z", approvedByUserId: "owner-1",
    revenueBreakdown: { productColumn: "product", quantityColumn: "quantity", quantityUnit: "items", currency: "NGN", confirmed: true }, ...extra };
}

export function salesReport({ rows = salesRows, sources, policy = salesPolicy(), options = {}, profile = {} } = {}) {
  return buildBusinessReport({ sources: sources ?? [salesSource(rows)], policies: policy ? [policy] : [],
    profile: { primaryCurrency: "NGN", ...profile }, options: { metric: "revenue", ...options } });
}

test("revenue change reconciles price, total volume and product mix independently", () => {
  const report = salesReport();
  const breakdown = report.revenueBreakdown;
  assert.equal(breakdown.status, "ready");
  assert.equal(breakdown.totalChange, "18");
  assert.deepEqual(breakdown.effects.map((effect) => [effect.id, effect.value]), [
    ["price", "8"], ["volume", "30"], ["mix", "-20"], ["first_sales", "0"], ["no_sales", "0"],
  ]);
  assert.equal(breakdown.reconciled, true);
  assert.equal(breakdown.previousQuantity, "10");
  assert.equal(breakdown.currentQuantity, "12");
  assert.deepEqual(breakdown.products.map((product) => product.name), ["A", "B"]);
  assert.equal(breakdown.evidence.definitionVersion, 1);
  assert.equal(breakdown.evidence.sources[0].id, "sales-source");
});

test("guided answers use the selected verified report and do not manufacture causes", () => {
  const report = salesReport();
  const questions = report.explainer.questions;
  const amount = questions.find((question) => question.id === "amount");
  assert.match(amount.answer, /150\.00/);
  assert.match(amount.answer, /168\.00/);
  assert.match(amount.answer, /18\.00/);
  assert.match(amount.answer, /Feb 2026/);
  assert.match(amount.answer, /Jan 2026/);
  assert.equal(amount.classification, "VERIFIED FACT");
  assert.deepEqual(amount.evidenceIds, ["report"]);
  assert.match(questions.find((question) => question.id === "contributors").caution, /cause/i);
  assert.equal(report.explainer.scope.period, "2026-02");
  assert.equal(report.explainer.scope.mappingVersion, 1);
});

test("an opposing leading category never inherits the total's build-on assessment", () => {
  const report = salesReport({ rows: salesRows.map((r, i) => ({ ...r, product: ["Core", "Absent", "Core", "First"][i], revenue: ["100", "60", "145", "45"][i] })) });
  assert.equal(report.health, "improving");
  assert.equal(report.drivers.entries[0].name, "Absent");
  const movement = report.priorities.find((p) => p.id === "movement");
  assert.equal(movement.quadrant, "monitor");
  assert.match(movement.interpretation, /opposes the overall change/);
});

test("a single product supports price and volume with zero mix", () => {
  const rows = salesRows.map((r) => ({ ...r, product: "A" }));
  const b = salesReport({ rows }).revenueBreakdown;
  assert.equal(b.status, "ready");
  assert.equal(b.effects.find((e) => e.id === "mix").value, "0");
  assert.equal(b.effects.find((e) => e.id === "price").value, "-12");
});

test("first and absent recorded sales do not masquerade as product price changes", () => {
  const rows = salesRows.map((r, i) => ({ ...r, product: ["Kept", "Absent", "Kept", "First"][i] }));
  const b = salesReport({ rows }).revenueBreakdown;
  assert.equal(b.effects.find((e) => e.id === "first_sales").value, "72");
  assert.equal(b.effects.find((e) => e.id === "no_sales").value, "-100");
  assert.equal(b.effects.find((e) => e.id === "price").value, "16");
  assert.equal(b.effects.find((e) => e.id === "volume").value, "30");
  assert.equal(b.effects.find((e) => e.id === "mix").value, "0");
  assert.doesNotMatch(b.effects.find((e) => e.id === "first_sales").label, /new|launch/i);
});

test("unsupported records with missing quantity, product, adjustments or incomplete dates stay explicit", () => {
  for (const [key, value, status] of [["quantity", "", "insufficient_evidence"], ["product", "", "insufficient_evidence"], ["revenue", "-96", "unsupported"], ["quantity", "-8", "unsupported"], ["quantity", "0", "unsupported"], ["date", "2026-02-02", "insufficient_evidence"]]) {
    const rows = salesRows.map((row, index) => index === 2 ? { ...row, [key]: value } : row);
    const report = salesReport({ rows });
    assert.equal(report.revenueBreakdown.status, status, `${key}: ${value}`);
    assert.deepEqual(report.revenueBreakdown.effects, []);
    assert.ok(report.explainer.questions.find((q) => q.id === "revenue").answer);
  }
});

test("mapping, currency and selected metric must match; no price inference without approval", () => {
  assert.equal(salesReport({ policy: null }).revenueBreakdown.status, "unconfigured");
  assert.equal(salesReport({ policy: salesPolicy({ revenueBreakdown: null }) }).revenueBreakdown.status, "unconfigured");
  assert.equal(salesReport({ profile: { primaryCurrency: "USD" } }).revenueBreakdown.status, "insufficient_evidence");
  assert.equal(salesReport({ options: { metric: "quantity" } }).revenueBreakdown.status, "unconfigured");
  assert.equal(salesReport({ options: { compare: "none" } }).revenueBreakdown.status, "insufficient_evidence");
  const sources = [salesSource(salesRows.slice(0, 2).map(({ date: _date, ...r }) => r), { id: "jan", period: "2026-01", checksum: "b".repeat(64) }), salesSource(salesRows.slice(2).map(({ date: _date, ...r }) => r), { id: "feb", period: "2026-02" })];
  assert.equal(salesReport({ sources, options: { source: "feb" } }).revenueBreakdown.status, "insufficient_evidence");
});

test("guided answers honor baseline, zero denominator and partial-period limitations", () => {
  const baseline = salesReport({ options: { period: "2026-01" } });
  assert.equal(baseline.explainer.scope.comparisonPeriod, null);
  assert.match(baseline.explainer.questions.find((q) => q.id === "amount").answer, /No earlier comparison/);
  const zero = salesReport({ rows: salesRows.map((r) => r.date.startsWith("2026-01") ? { ...r, revenue: "0" } : r) });
  assert.match(zero.explainer.questions.find((q) => q.id === "amount").answer, /percentage is not meaningful/);
  const partial = salesReport({ rows: salesRows.map((r, i) => i === 2 ? { ...r, date: "2026-02-02" } : r) });
  assert.match(partial.explainer.questions.find((q) => q.id === "assessment").answer, /withheld/);
});

test("prior period selection does not pull future revenue or explanation into the report", () => {
  const report = salesReport({ options: { period: "2026-01", compare: "none" } });
  assert.equal(report.current.value, "150");
  assert.doesNotMatch(report.explainer.questions.find((q) => q.id === "amount").answer, /168|Feb 2026/);
  assert.equal(report.revenueBreakdown.status, "insufficient_evidence");
});

test("price-volume-mix preserves exact decimal reconciliation across varied fractional prices", () => {
  let roundingCases = 0;
  for (let i = 1; i <= 120; i++) {
    const rows = salesRows.map((r, index) => ({ ...r, quantity: String(1 + (i * (index + 3) % 17)), revenue: `${1 + (i * (index + 5) % 131)}.1234567891` }));
    const b = salesReport({ rows }).revenueBreakdown;
    assert.equal(b.status, "ready");
    assert.equal(b.effects.reduce((sum, effect) => sum + parseReportNumber(effect.value), 0n), parseReportNumber(b.totalChange));
    roundingCases += Number(b.effects.some((effect) => effect.id === "rounding"));
  }
  assert.ok(roundingCases > 0);
});

test("recurring sources and duplicate exclusions apply to quantities as well as revenue", () => {
  const january = salesSource(salesRows.slice(0, 2), { id: "jan", period: "2026-01", checksum: "b".repeat(64) });
  const february = salesSource(salesRows.slice(2), { id: "feb", period: "2026-02" });
  const original = JSON.stringify([january, february]);
  const duplicate = { ...january, id: "duplicate" };
  const b = salesReport({ sources: [january, february, duplicate], options: { source: "feb" } }).revenueBreakdown;
  assert.equal(b.totalChange, "18");
  assert.deepEqual(b.evidence.sources.map((s) => s.id).sort(), ["feb", "jan"]);
  assert.equal(JSON.stringify([january, february]), original);
});

test("disjoint extracts use combined month coverage while incomplete middle months stay limited", () => {
  const row = (date, quantity, revenue) => ({ date, product: "A", quantity, revenue });
  const sources = [salesSource([row("2026-01-01", "1", "10"), row("2026-01-15", "1", "10")], { id: "jan-start", checksum: "b".repeat(64), period: "2026-01" }), salesSource([row("2026-01-16", "1", "10"), row("2026-01-31", "1", "10")], { id: "jan-end", checksum: "c".repeat(64), period: "2026-01" }), salesSource([row("2026-02-01", "3", "30"), row("2026-02-28", "3", "30")], { id: "feb" })];
  const merged = salesReport({ sources, options: { source: "feb" } });
  assert.equal(merged.previous.partial, false);
  assert.equal(merged.revenueBreakdown.status, "ready");
  assert.equal(merged.revenueBreakdown.totalChange, "20");
  const middle = salesReport({ rows: [...salesRows.map((r) => r.date === "2026-02-28" ? { ...r, date: "2026-02-27" } : r), row("2026-03-01", "3", "30"), row("2026-03-31", "3", "30")], options: { period: "2026-02" } });
  assert.equal(middle.current.partial, true);
  assert.equal(middle.revenueBreakdown.status, "insufficient_evidence");
});

test("large exact currency totals are not rounded through binary floating-point in explanatory text", () => {
  const report = salesReport({ rows: salesRows.map((r, i) => ({ ...r, revenue: i === 3 ? "9007199254740993.01" : "0" })) });
  assert.match(report.explainer.questions.find((q) => q.id === "amount").answer, /9,007,199,254,740,993\.01/);
  assert.match(reportValue(report.current.value, report.metric), /9,007,199,254,740,993\.01/);
});

test("an aggregate mismatch is not disguised as a rounding contribution", () => {
  const source = salesSource(salesRows);
  const item = source.cube.metrics.find((m) => m.column === "revenue");
  const dates = item.dates[0];
  const previous = { ...dates.months[0], sourceIds: [source.id] }, current = { ...dates.months[1], value: "999", sourceIds: [source.id] };
  const result = buildRevenueBreakdown({ accepted: [{ source, item, dates }], current, previous, policy: salesPolicy(), metric: item, currency: "NGN", dateColumn: "date", blocked: false });
  assert.equal(result.status, "insufficient_evidence");
  assert.deepEqual(result.effects, []);
});

test("definition validation rejects forged or unavailable revenue mappings", () => {
  const policy = salesPolicy();
  const source = salesSource(salesRows);
  const approved = validateReportPolicy(policy);
  validateRevenueMappingSource(source, "revenue", approved, "NGN");
  for (const mapping of [{ ...policy.revenueBreakdown, confirmed: false }, { ...policy.revenueBreakdown, quantityUnit: "" }, { ...policy.revenueBreakdown, productColumn: "quantity" }, { ...policy.revenueBreakdown, currency: "invalid" }]) assert.throws(() => validateReportPolicy({ ...policy, revenueBreakdown: mapping }));
  for (const mapping of [{ ...policy.revenueBreakdown, quantityColumn: "revenue" }, { ...policy.revenueBreakdown, quantityColumn: "not_here" }, { ...policy.revenueBreakdown, productColumn: "not_here" }, { ...policy.revenueBreakdown, currency: "USD" }]) assert.throws(() => validateRevenueMappingSource(source, "revenue", validateReportPolicy({ ...policy, revenueBreakdown: mapping }), "NGN"));
});

test("HTML and CSV exports include guided answers, complete evidence and safe user labels", () => {
  const report = salesReport({ rows: salesRows.map((r) => ({ ...r, product: r.product === "A" ? '<img src=x onerror=alert(1)>' : "=DANGEROUS()" })) });
  const html = renderReportHtml(report);
  assert.match(html, /Understand this report/);
  assert.match(html, /Product mix/);
  assert.doesNotMatch(html, /<script|<img src=x/i);
  assert.match(html, /&lt;img/);
  const rows = parse(renderReportCsv(report), { bom: true, columns: true });
  assert.ok(rows.some((row) => row.Kind === "Revenue effect" && row.Category === "Product mix" && row["Absolute movement"] === "-20"));
  assert.ok(rows.some((row) => row.Category === "'=DANGEROUS()"));
  assert.ok(rows.some((row) => row.Category === "How much changed, in actual money or units?"));
});

test("PDF export retains full answers and revenue provenance without silent truncation", async () => {
  const report = salesReport();
  const pdf = await renderReportPdf(report);
  const reader = new PDFParse({ data: pdf });
  try {
    const { text, pages } = await reader.getText();
    assert.match(text, /Product mix/);
    assert.match(text, /How much changed, in actual money or units/);
    assert.match(text, /First\/no recorded sales|neither label proves a launch/);
    assert.match(text, /quantity point aggregate/);
    assert.match(text, /Evidence quality describes coverage and traceability/);
    assert.ok(pages.every((page) => page.text.length > 100), "Footers must not generate blank pages");
    for (const page of pages) assert.ok(page.text.includes(`${page.num} / ${pages.length}`), "Page numbering must stay on its content page");
  } finally { await reader.destroy(); }
});
