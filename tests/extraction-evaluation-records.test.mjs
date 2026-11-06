import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { documents, sourceHtml, sourceText } from "./fixtures/everyday-records/input-documents.mjs";
import { expectedFields, scoreExtraction, possibleDuplicateCaptures } from "../scripts/lib/record-evaluation.mjs";
import { generateEvaluationFixtures } from "../scripts/generate-extraction-fixtures.mjs";
import { parseReportNumber } from "../src/reports/decimal.mjs";

const manifest = JSON.parse(readFileSync(new URL("./fixtures/everyday-records/ground-truth.json", import.meta.url)));
const goldPrediction = () => ({ cases: manifest.cases.map(item => ({ fixtureId: item.fixtureId, recordType: item.recordType,
  fields: structuredClone(expectedFields(manifest, item)), requiredReviewDecisions: [...item.requiredReviewDecisions], relationships: structuredClone(item.relationships) })) });

test("owner scenarios preserve separate source documents and synthetic ground truth", () => {
  assert.equal(documents.length, 9);
  assert.deepEqual(documents.map(item => item.id), manifest.cases.map(item => item.fixtureId));
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.productionImportAllowed, false);
  for (const document of documents) {
    assert.match(sourceText(document), /SYNTHETIC TEST RECORD/);
    assert.match(sourceHtml(document, true), /SYNTHETIC TEST RECORD/);
    assert.doesNotMatch(sourceHtml(document, true), /EXPECTED INTERPRETATION|requiredReviewDecisions|prohibitedClaims/);
  }
  assert.doesNotMatch(readFileSync("scripts/lib/record-fixture-renderer.mjs", "utf8"), /ground-truth|expectedFields|scoreExtraction/);
});

test("financial identities use exact decimals without confusing revenue, cash and withdrawals", () => {
  const value = (id, key) => parseReportNumber(expectedFields(manifest, manifest.cases.find(item => item.fixtureId === id))[key].value);
  assert.equal(value("01-supplier", "goodsSubtotal") + value("01-supplier", "transport"), value("01-supplier", "total"));
  assert.equal(value("01-supplier", "total") - value("01-supplier", "paid"), value("01-supplier", "payable"));
  assert.equal(value("02-sales", "cashReceived") + value("02-sales", "transferReceived"), value("02-sales", "receivedTotal"));
  assert.equal(value("02-sales", "salesTotal") - value("02-sales", "receivedTotal"), value("02-sales", "receivable"));
  assert.equal(value("03-withdrawal", "businessOutflows") + value("03-withdrawal", "ownerWithdrawal"), value("03-withdrawal", "totalMoneyOut"));
  assert.equal(value("04-service", "received") - value("04-service", "directCostsPaid"), value("04-service", "netRecordedCashMovement"));
  assert.equal(value("05-correction", "quantity") * value("05-correction", "unitPrice") / parseReportNumber("1"), value("05-correction", "total"));
  assert.equal(value("08-repayment", "newSalesRevenue"), 0n);
});

test("scorer self-test does not claim OCR execution or real-world accuracy", () => {
  const result = scoreExtraction(manifest, goldPrediction());
  assert.equal(result.passed, true);
  assert.equal(result.extractionExecutedByScorer, false);
  assert.equal(result.provesRealWorldAccuracy, false);
});

test("scorer rejects guesses, classification errors, missing review and unexpected fields", () => {
  const predictions = goldPrediction();
  predictions.cases.find(item => item.fixtureId === "06-ambiguous").fields.total = { value: "15000.00", provenance: "explicit" };
  predictions.cases.find(item => item.fixtureId === "02-sales").fields["lines.0.unitPrice"].provenance = "explicit";
  predictions.cases.find(item => item.fixtureId === "04-service").fields.netProfit = { value: "5000.00", provenance: "derived" };
  predictions.cases.find(item => item.fixtureId === "03-withdrawal").claims = ["owner_food_is_business_expense"];
  predictions.cases.find(item => item.fixtureId === "08-repayment").requiredReviewDecisions = [];
  predictions.cases[0].fields.constructor = { value: "unexpected", provenance: "explicit" };
  const result = scoreExtraction(manifest, predictions);
  assert.equal(result.passed, false);
  assert.ok(result.cases[0].errors.includes("unexpected_field:constructor"));
  assert.ok(result.cases.find(item => item.fixtureId === "06-ambiguous").errors.includes("unsafe_guess:total"));
  assert.ok(result.cases.find(item => item.fixtureId === "04-service").errors.includes("unsafe_guess:netProfit"));
  assert.ok(result.cases.find(item => item.fixtureId === "02-sales").errors.includes("field:lines.0.unitPrice"));
  assert.ok(result.cases.find(item => item.fixtureId === "03-withdrawal").errors.includes("prohibited_claim:owner_food_is_business_expense"));
});

test("scorer rejects malformed inputs, missing cases, duplicates and unauthorized import", () => {
  for (const input of [{}, { cases: {} }, { cases: [null] }, { cases: [{ fixtureId: "x", fields: {}, requiredReviewDecisions: "not-array" }] }]) {
    assert.throws(() => scoreExtraction(manifest, input), TypeError);
  }
  assert.equal(scoreExtraction(manifest, { cases: [] }).passed, false);
  const predictions = goldPrediction();
  predictions.cases.push(structuredClone(predictions.cases[0]));
  predictions.cases[1].importApproved = true;
  assert.equal(scoreExtraction(manifest, predictions).passed, false);
});

test("duplicate candidates ignore checksums but reject invalid amounts and never approve import", () => {
  const base = { supplier: "DEMO Ade Provision Supplies", receiptId: "DEMO-001", date: "2026-10-18", currency: "NGN", total: "50500.00" };
  const proposals = [{ ...base, captureId: "a", checksum: "one" }, { ...base, captureId: "b", checksum: "two" }];
  assert.deepEqual(possibleDuplicateCaptures(proposals), [{ captureIds: ["a", "b"], reason: "same_supplier_receipt_date_currency_total", requiresReview: true, importApproved: false }]);
  assert.equal(possibleDuplicateCaptures([proposals[0], { ...proposals[1], supplier: "Different business" }]).length, 0);
  assert.equal(possibleDuplicateCaptures([proposals[0], { ...proposals[1], total: null }]).length, 0);
  assert.equal(possibleDuplicateCaptures(proposals.map(item => ({ ...item, total: "9".repeat(100) }))).length, 0);
});

test("canonical generator offers owner records without changing legacy defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "biznoryx-owner-records-"));
  try {
    const result = await generateEvaluationFixtures(root, { suite: "owner-records" });
    assert.equal(result.captures, 9);
    const index = JSON.parse(await readFile(join(root, "input-index.json"), "utf8"));
    const answers = JSON.parse(await readFile(join(root, "answers", "expected.json"), "utf8"));
    assert.deepEqual(answers, manifest);
    for (const file of index.files) {
      const source = await readFile(join(root, "inputs", file.cleanText), "utf8");
      assert.match(source, /SYNTHETIC TEST RECORD/);
      assert.doesNotMatch(source, /EXPECTED INTERPRETATION|requiredReviewDecisions/);
      assert.equal(file.visual, undefined);
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("offline scorer CLI distinguishes matches, mismatches and invalid bounded input", async () => {
  const root = await mkdtemp(join(tmpdir(), "biznoryx-scorer-"));
  const filename = join(root, "predictions.json");
  const run = () => spawnSync(process.execPath, ["scripts/evaluate-extraction-fixtures.mjs", filename], { encoding: "utf8" });
  try {
    await writeFile(filename, JSON.stringify(goldPrediction()));
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).extractionExecutedByScorer, false);
    await writeFile(filename, JSON.stringify({ cases: [] }));
    assert.equal(run().status, 1);
    await writeFile(filename, JSON.stringify({ cases: "invalid" }));
    assert.equal(run().status, 2);
    await writeFile(filename, " ".repeat(2 * 1024 * 1024 + 1));
    assert.equal(run().status, 2);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
