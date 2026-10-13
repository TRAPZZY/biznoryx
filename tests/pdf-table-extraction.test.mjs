import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extractPdfTable } from "../src/ingestion/pdf-ingestion.mjs";
import { PDF_LIMITS, tableFromPdfPages } from "../src/ingestion/pdf-table-structure.mjs";
import { deriveSourceMetrics } from "../src/worker/production-worker.mjs";
import { tablePdf } from "./helpers/pdf-fixtures.mjs";

test("PDF worker metrics remain decimal exact and carry original/extracted provenance", async () => {
  const body = await tablePdf([
    [["date", "product", "revenue"], ["2026-10-01", "Service A", "125.51"]],
    [["date", "product", "revenue"], ["2026-10-02", "Service B", "74.50"]],
  ]);
  const metrics = await deriveSourceMetrics({ body, contentType: "application/pdf", originalFilename: "sales.pdf" });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].value, "200.01");
  assert.equal(metrics[0].sourceRowCount, 2);
  assert.equal(metrics[0].evidence.parser, "pdf-text-table");
  assert.equal(metrics[0].evidence.fileName, "sales.pdf");
  assert.equal(metrics[0].evidence.sourceChecksumSha256, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(metrics[0].evidence.pageRanges, [{ page: 1, firstDataRow: 1, lastDataRow: 1 }, { page: 2, firstDataRow: 2, lastDataRow: 2 }]);
});

test("PDF extraction rejects password protection, blank/scanned pages and mixed schemas", async () => {
  const protectedPdf = await tablePdf(undefined, { userPassword: "not-a-real-user-secret" });
  await assert.rejects(extractPdfTable(protectedPdf), /password-protected|Encrypted/);
  await assert.rejects(extractPdfTable(await tablePdf([[]])), /scanned|unreadable/);
  await assert.rejects(extractPdfTable(await tablePdf([
    [["date", "revenue"], ["2026-10-01", "1"]],
    [["date", "amount"], ["2026-10-02", "2"]],
  ])), /same table header/);
});

test("PDF parser timeout releases capacity and a following extraction succeeds", async () => {
  const body = await tablePdf();
  await assert.rejects(extractPdfTable(body, { timeoutMs: 1 }), /timed out/);
  const table = await extractPdfTable(body);
  assert.equal(table.rowCount, 2);
});

test("strict table contract rejects ambiguous amounts, dates, summaries and missing cells", () => {
  for (const row of ["2026-10-01,", "2026-10-01,$100", "2026-02-30,100", "01/10/2026,100", "Total,100", "2026-10-01,100,extra"]) {
    assert.throws(() => tableFromPdfPages([{ text: "date,revenue\n" + row }]));
  }
  assert.throws(() => tableFromPdfPages([{ text: "revenue,revenue\n1,2" }]), /unique/);
  assert.throws(() => tableFromPdfPages([{ text: "Notes about a business\nRevenue is probably 100" }]), /explicit/);
  assert.throws(() => tableFromPdfPages([{ text: "date,revenue\n2026-10-01,100\nNote: a forecast follows" }]), /inconsistent/);
  assert.throws(() => tableFromPdfPages(Array.from({ length: PDF_LIMITS.pages + 1 }, () => ({ text: "date,revenue\n2026-10-01,1" }))), /50 pages/);
  assert.throws(() => tableFromPdfPages([{ text: "date,revenue\n" + "x".repeat(PDF_LIMITS.textBytes) }]), /text limit/);
});

test("explicit CSV text inside a PDF table preserves supplied cells without guessing", () => {
  const table = tableFromPdfPages([{ text: 'date,description,amount\n2026-10-01,"Item, supplied",-12.50' }]);
  assert.equal(table.rowCount, 1);
  assert.match(table.csv, /"Item, supplied","-12.50"/);
});
