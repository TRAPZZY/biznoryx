import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBusinessReport,
  buildReportCube,
} from "../src/reports/evidence-engine.mjs";
import {
  buildMonthlyClosePacket,
  canonicalJson,
  monthlyCloseHash,
  approvalBlockers,
} from "../src/reports/monthly-close.mjs";

export function evidenceReport({
  policy = true,
  partial = false,
  value = "9007199254740993.01",
} = {}) {
  const cube = buildReportCube({
    rows: [
      { date: "2026-10-01", product: "A", revenue: value },
      { date: "2026-10-31", product: "A", revenue: "0" },
    ],
  });
  const report = buildBusinessReport({
    sources: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        seriesKey: "22222222-2222-4222-8222-222222222222",
        period: "2026-10",
        fileName: "sales.csv",
        dataStatus: partial ? "partial" : "complete",
        checksum: "a".repeat(64),
        rawDataObjectId: "33333333-3333-4333-8333-333333333333",
        metricPointIds: { revenue: "44444444-4444-4444-8444-444444444444" },
        confirmedAt: "2026-11-01T00:00:00.000Z",
        cube,
      },
    ],
    profile: { primaryCurrency: "NGN" },
    options: { period: "2026-10" },
    policies: policy
      ? [
          {
            seriesKey: "22222222-2222-4222-8222-222222222222",
            column: "revenue",
            version: 1,
            label: "Revenue",
            unit: "currency",
            polarity: "higher",
            materialityPercent: 5,
            approvedByUserId: "55555555-5555-4555-8555-555555555555",
          },
        ]
      : [],
    now: new Date("2026-11-02T00:00:00.000Z"),
  });
  report.evidence.sourceChecklist = {
    confirmed: true,
    version: 1,
    period: "2026-10",
    sources: [
      { streamId: "22222222-2222-4222-8222-222222222222", status: "ready" },
    ],
  };
  return report;
}

test("monthly close preserves exact decimals and pins evidence with canonical hashes", () => {
  const report = evidenceReport();
  const packet = buildMonthlyClosePacket({ period: "2026-10", report });
  assert.equal(packet.report.current.value, "9007199254740993.01");
  assert.equal(packet.evidenceManifest.mappingVersion, 1);
  assert.equal(packet.evidenceManifest.sources[0].checksum, "a".repeat(64));
  assert.equal(
    packet.evidenceManifest.sources[0].metricPointId,
    "44444444-4444-4444-8444-444444444444",
  );
  assert.deepEqual(approvalBlockers(packet), []);
  assert.equal(
    monthlyCloseHash(packet),
    monthlyCloseHash(Object.fromEntries(Object.entries(packet).reverse())),
  );
  const changed = structuredClone(packet);
  changed.report.current.value = "9007199254740993.02";
  assert.notEqual(monthlyCloseHash(packet), monthlyCloseHash(changed));
  report.current.value = "0";
  assert.equal(packet.report.current.value, "9007199254740993.01");
  assert.ok(
    packet.limitations.some((x) => x.code === "NO_CASH_RECONCILIATION"),
  );
});

test("approval cannot acknowledge away missing definitions, empty data or incomplete coverage", () => {
  assert.ok(
    approvalBlockers(
      buildMonthlyClosePacket({
        period: "2026-10",
        report: evidenceReport({ policy: false }),
      }),
    ).includes("MAPPING_UNCONFIRMED"),
  );
  assert.ok(
    approvalBlockers(
      buildMonthlyClosePacket({
        period: "2026-10",
        report: evidenceReport({ partial: true }),
      }),
    ).includes("PARTIAL_PERIOD"),
  );
  const report = evidenceReport();
  report.current.rows = 0;
  assert.ok(
    approvalBlockers(
      buildMonthlyClosePacket({ period: "2026-10", report }),
    ).includes("EMPTY_METRICS"),
  );
  report.current.value = 123;
  assert.throws(
    () => buildMonthlyClosePacket({ period: "2026-10", report }),
    /decimal string/i,
  );
});

test("bounded JSON rejects executable, lossy, circular, deep and oversized input", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    { x: undefined },
    { x() {} },
  ])
    assert.throws(() => canonicalJson(value));
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular));
  let deep = {};
  for (let i = 0; i < 35; i++) deep = { next: deep };
  assert.throws(() => canonicalJson(deep), /budget|depth/i);
  assert.throws(
    () => canonicalJson({ text: "x".repeat(2 * 1024 * 1024) }),
    /budget|size/i,
  );
  assert.equal(
    canonicalJson({ z: [2, 1], a: { z: 2, a: 1 } }),
    '{"a":{"a":1,"z":2},"z":[2,1]}',
  );
  assert.throws(() =>
    buildMonthlyClosePacket({ period: "2026-13", report: evidenceReport() }),
  );
  assert.throws(
    () =>
      buildMonthlyClosePacket({ period: "2026-09", report: evidenceReport() }),
    /period/i,
  );
});
