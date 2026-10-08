import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "csv-parse/sync";
import {
  MANUAL_ENTRY_LIMITS, ManualEntryService, SALES_COLUMNS, assertGridLimits, canonicalMonthlyCsv,
  monthlyPeriod, validateGrid,
} from "../src/ingestion/manual-entry.mjs";

const grid = (rows, extra = {}) => validateGrid({ columns: SALES_COLUMNS, rows, period: "2026-10", ...extra });

test("daily cells retain exact decimals and do not fabricate empty optional numbers", () => {
  const columns = [{ name: "product", type: "text", required: true }, { name: "amount", type: "decimal", required: false }];
  const result = validateGrid({ columns, rows: [["A", ""], ["B", "1234567890123456789012345678.1234567890"]], period: "2026-10", entryDate: "2026-10-03" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.normalizedRows, [["A", ""], ["B", "1234567890123456789012345678.1234567890"]]);
  assert.match(canonicalMonthlyCsv(columns, result.normalizedRows), /"A",""/);
});

test("cell validation reports original 1-based row and column for real dates and decimals", () => {
  const result = grid([["", "", "", ""], ["2026-02-30", "A", "1,00", "1e3"], ["2026-09-30", "B", "2", "0.1"]]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.row === 2 && issue.column === 1 && issue.code === "DATE_INVALID"));
  assert.ok(result.issues.some((issue) => issue.row === 2 && issue.column === 3 && issue.code === "DECIMAL_INVALID"));
  assert.ok(result.issues.some((issue) => issue.row === 2 && issue.column === 4 && issue.code === "DECIMAL_INVALID"));
  assert.ok(result.issues.some((issue) => issue.row === 3 && issue.code === "DATE_OUTSIDE_PERIOD"));
});

test("blank rows are ignored; incomplete populated rows still fail; zero is data", () => {
  assert.equal(grid([["", " ", "", ""]]).valid, false);
  const result = grid([["2026-10-01", "A", "0", "0.00"], ["", "", "", ""]]);
  assert.equal(result.valid, true);
  assert.equal(result.rowCount, 1);
  assert.equal(result.normalizedRows.length, 1);
  assert.equal(grid([["2026-10-01", "A", "", ""]]).valid, false);
});

test("single-month boundaries handle leap years and reject invalid periods", () => {
  assert.equal(monthlyPeriod("2024-02").periodEnd, "2024-02-29");
  assert.equal(monthlyPeriod("2026-12").periodEnd, "2026-12-31");
  for (const period of ["2026-00", "2026-13", "2026-1", "0026-01", "2026-01-01", null]) assert.throws(() => monthlyPeriod(period));
  assert.equal(grid([["2026-10-32", "A", "1", "1"]]).valid, false);
});

test("boolean, integer and text schemas validate without invented numeric columns", () => {
  const columns = [{ name: "active", type: "boolean" }, { name: "count", type: "integer" }, { name: "note", type: "text" }];
  const input = { columns, rows: [["YES", "-2", "memo"]], period: "2026-10", entryDate: "2026-10-02" };
  assert.deepEqual(validateGrid(input).normalizedRows, [["yes", "-2", "memo"]]);
  assert.equal(validateGrid({ ...input, entryDate: "2026-09-02" }).valid, false);
  assert.equal(validateGrid({ ...input, rows: [["maybe", "1.5", "memo"]] }).issues.length, 2);
  assert.equal(validateGrid({ ...input, columns: [{ name: "active", type: "unknown" }, ...columns.slice(1)] }).valid, false);
});

test("CSV escaping blocks formulas in text, preserves decimal negatives and duplicates", () => {
  const columns = [{ name: "description", type: "text" }, { name: "amount", type: "decimal" }];
  const rows = [[' =SUM(1,2)\n"quoted"', "-12.50"], ["@SUM(A1)", "0.10"], ["@SUM(A1)", "0.10"]];
  const parsed = parse(canonicalMonthlyCsv(columns, rows));
  assert.deepEqual(parsed[1], [`'${rows[0][0]}`, "-12.50"]);
  assert.equal(parsed[2][0], "'@SUM(A1)");
  assert.deepEqual(parsed[2], parsed[3]);
});

test("grid limits cover row, cell, column, bytes, malformed shape and control characters", () => {
  assert.throws(() => assertGridLimits(Array(MANUAL_ENTRY_LIMITS.rows + 1).fill(["x"]), [{ name: "x", type: "text" }]));
  assert.throws(() => assertGridLimits([], Array(MANUAL_ENTRY_LIMITS.columns + 1).fill({ name: "x" })));
  assert.throws(() => assertGridLimits(Array(5001).fill(Array(200).fill("")), Array(200).fill({ name: "x" })));
  assert.throws(() => assertGridLimits([["x".repeat(MANUAL_ENTRY_LIMITS.cellBytes + 1)]], [{ name: "x" }]));
  assert.throws(() => assertGridLimits(Array(1000).fill(["x".repeat(32 * 1024)]), [{ name: "x" }]));
  assert.throws(() => assertGridLimits([[1]], [{ name: "x" }]));
  assert.throws(() => assertGridLimits([["x", "y"]], [{ name: "x" }]));
  assert.equal(grid([["2026-10-02", "A\u0000", "1", "2"]]).valid, false);
});

test("object-write failure leaves durable submission available for the exact retry", async () => {
  const prepared = { draft: { id: "draft" }, submission: { id: "submission", organizationId: "org", fileName: "sales.csv", snapshotCsv: "date,revenue\n2026-10-01,1\n" }, upload: null };
  let prepareCalls = 0;
  let finalizeCalls = 0;
  const repository = {
    async prepareSubmission() { prepareCalls += 1; return prepared; },
    async finalizeSubmission(input) { finalizeCalls += 1; assert.equal(input.submissionId, "submission"); return { ...prepared, upload: { ingestionRun: { id: "run" } } }; },
  };
  let fail = true;
  const service = new ManualEntryService({ repository, objectStorage: {
    async headObject() { return { exists: false }; },
    async putObject({ body }) { assert.ok(Buffer.isBuffer(body)); if (fail) throw new Error("Storage unavailable"); },
  } });
  await assert.rejects(service.submit({ draftId: "draft", version: 1 }), /Storage unavailable/);
  assert.equal(finalizeCalls, 0);
  fail = false;
  assert.equal((await service.submit({ draftId: "draft", version: 1 })).upload.ingestionRun.id, "run");
  assert.equal(prepareCalls, 2);
  assert.equal(finalizeCalls, 1);
});

test("completed submit retry returns its committed upload without touching storage", async () => {
  const result = { draft: {}, submission: {}, upload: { ingestionRun: { id: "run" } } };
  const service = new ManualEntryService({ repository: { async prepareSubmission() { return result; } }, objectStorage: {} });
  assert.equal(await service.submit({}), result);
});
