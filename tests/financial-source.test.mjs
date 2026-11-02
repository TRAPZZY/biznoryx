import test from "node:test";
import assert from "node:assert/strict";
import {
  financialDate,
  financialSourcePreview,
} from "../src/ingestion/money-trail-source.mjs";
import { validateImportProfile } from "../src/database/import-manifest-repository.mjs";
import { validationIssueCsv } from "../web-app/business-review.js";
import { parse } from "csv-parse/sync";
import { normalizeTabularUpload } from "../src/ingestion/tabular-upload.mjs";
import { applyImportProfile } from "../src/ingestion/profile-normalization.mjs";
test("financial source mappings preserve exact amounts, explicit date convention and unknown payment status", () => {
  const profile = validateImportProfile({
    sourceRole: "sales",
    currency: "NGN",
    dateConvention: "DMY",
    columns: ["date", "amount", "reference"],
    mapping: { date: "date", amount: "amount", reference: "reference" },
  });
  const result = financialSourcePreview({
    body: Buffer.from(
      'date,amount,reference\n03/04/2026,"9,007,199,254,740,993.01",0012\n31/04/2026,100,B\n01/04/2026,1k,C\n',
    ),
    profile,
    sourceChecksum: "a".repeat(64),
    profileId: "test",
  });
  assert.equal(result.records[0].date, "2026-04-03");
  assert.equal(result.records[0].amount, "9007199254740993.01");
  assert.equal(result.records[0].reference, "0012");
  assert.equal(result.records[0].paymentStatus, "unknown");
  assert.equal(result.records[0].referenceConfirmed, false);
  assert.deepEqual(
    result.issues.map((i) => i.row),
    [3, 4],
  );
  assert.equal(result.records.length, 1);
  assert.equal(financialDate("03/04/2026", "MDY"), "2026-03-04");
  assert.throws(() => financialDate("03/04/26", "DMY"), /four-digit/);
  assert.throws(
    () =>
      financialSourcePreview({
        body: Buffer.from("date,amount,reference\n2026-01-01,10,A"),
        profile: { ...profile, currency: "USD" },
      }),
    /NGN/,
  );
  assert.throws(
    () => validateImportProfile({ ...profile, mapping: { amount: "missing" } }),
    /missing/,
  );
});

test("downloaded validation issues are valid CSV and cannot become spreadsheet formulas", () => {
  const csv = validationIssueCsv([
    {
      row: 2,
      column: "amount",
      message: ' =HYPERLINK("https://example.invalid","test")',
    },
    { row: 3, column: "date", message: "Line one\nLine two" },
  ]);
  const rows = parse(csv, { columns: true });
  assert.equal(rows[0].problem.startsWith("'"), true);
  assert.equal(rows[1].problem, "Line one\nLine two");
  assert.equal(rows[0].row, "2");
});

test("approved date mapping normalizes worker dates without changing original bytes or guessing a convention", async () => {
  const content = "\ufeffdate,amount\r\n03/04/2026,9007199254740993.01\r\n";
  const parsed = await normalizeTabularUpload({
    fileName: "dated.csv",
    content,
  });
  const definition = validateImportProfile({
    sourceRole: "sales",
    currency: "NGN",
    dateConvention: "DMY",
    columns: ["date", "amount"],
    mapping: { date: "date", amount: "amount" },
  });
  const normalized = applyImportProfile(parsed, definition);
  assert.deepEqual(normalized.originalBytes, Buffer.from(content));
  assert.equal(
    normalized.normalizedContent,
    "date,amount\n2026-04-03,9007199254740993.01\n",
  );
  assert.equal(normalized.normalization.dateConvention, "ISO");
  assert.equal(
    applyImportProfile(parsed, { ...definition, dateConvention: "MDY" })
      .normalizedContent,
    "date,amount\n2026-03-04,9007199254740993.01\n",
  );
  assert.throws(
    () => applyImportProfile(parsed, { ...definition, dateConvention: "ISO" }),
    (error) => error.issues[0].row === 2,
  );
});
