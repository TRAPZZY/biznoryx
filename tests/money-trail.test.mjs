import assert from "node:assert/strict";
import test from "node:test";
import {
  decimalMoney,
  normalizeMoneyRecord,
  normalizeClassification,
  moneyTrailPeriod,
  moneyTrailReport,
} from "../src/reports/money-trail.mjs";

const record = {
  sourceRowLocator: "csv:2",
  date: "2026-01-05",
  reference: "INV-1",
  description: "Invoice",
  amount: "100000",
  kind: "sale",
};

test("money is exact, bounded decimal text; numbers, rounding and exponent notation are rejected", () => {
  assert.equal(decimalMoney("9999999999999999.99"), "9999999999999999.99");
  assert.equal(decimalMoney("0.1"), "0.10");
  for (const value of [
    1,
    "1e3",
    "1.001",
    "-1",
    "0",
    "NaN",
    "10000000000000000",
    "01.00",
    " 1 ",
  ]) {
    assert.throws(() => decimalMoney(value), {
      code: "MONEY_TRAIL_INVALID_INPUT",
    });
  }
});

test("source records preserve actual dates and do not infer payment or due dates", () => {
  const normalized = normalizeMoneyRecord(record);
  assert.equal(normalized.amount, "100000.00");
  assert.equal(normalized.paymentStatus, "unknown");
  assert.equal(normalized.dueDate, null);
  assert.equal(normalized.referenceConfirmed, false);
  assert.equal(
    normalizeMoneyRecord({ ...record, kind: "receipt", date: "2026-02-20" })
      .date,
    "2026-02-20",
  );
  for (const extra of [
    { date: "2026-02-30" },
    { kind: "profit" },
    { sourceRowLocator: "" },
    { referenceConfirmed: "true" },
    { currency: "USD" },
    { paymentStatus: "unpaid" },
    { dueDate: "2026-01-30" },
    { description: "x".repeat(2001) },
  ]) {
    assert.throws(() => normalizeMoneyRecord({ ...record, ...extra }), {
      code: "MONEY_TRAIL_INVALID_INPUT",
    });
  }
});

test("classification is explicit, reversible review data; confirmed receivable is required for due dates", () => {
  assert.deepEqual(
    normalizeClassification({
      kind: "sale",
      paymentStatus: "confirmed_receivable",
      dueDate: "2026-02-01",
      reason: "Owner confirmed invoice terms",
    }),
    {
      kind: "sale",
      paymentStatus: "confirmed_receivable",
      dueDate: "2026-02-01",
      referenceConfirmed: false,
      reason: "Owner confirmed invoice terms",
    },
  );
  assert.throws(() =>
    normalizeClassification({
      kind: "receipt",
      paymentStatus: "confirmed_receivable",
      reason: "Wrong",
    }),
  );
  assert.throws(() => normalizeClassification({ kind: "unknown" }));
});

test("monthly periods are calendar bounded and explicit", () => {
  assert.deepEqual(moneyTrailPeriod("2028-02"), {
    period: "2028-02",
    start: "2028-02-01",
    endExclusive: "2028-03-01",
  });
  assert.equal(moneyTrailPeriod().start, null);
  for (const value of ["2026-13", "2026-1", {}, "2026-01-02"])
    assert.throws(() => moneyTrailPeriod(value));
});

test("report contract preserves decimal strings, limited details and full aggregate scope", () => {
  const result = moneyTrailReport({
    period: "2026-01",
    records: [],
    allocations: [],
    suggestions: [],
    totals: {
      recordedSales: "100000.00",
      allocatedReceipts: "60000.00",
      confirmedBalance: "40000.00",
    },
    reviewCounts: { classificationRequired: 1 },
    recordCount: 501,
  });
  assert.equal(result.totals.recordedSales, "100000.00");
  assert.equal(result.totals.confirmedBalance, "40000.00");
  assert.equal(result.reviewCounts.classificationRequired, 1);
  assert.equal(result.recordCount, 501);
  assert.equal(result.hasMoreRecords, true);
  assert.match(result.balanceBasis, /all dates/);
  assert.equal("profit" in result.totals, false);
});
