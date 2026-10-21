import { readFile, stat } from "node:fs/promises";
import { scoreExtraction } from "./lib/record-evaluation.mjs";

const filename = process.argv[2];
if (!filename || process.argv.length !== 3) {
  console.error("Usage: node scripts/evaluate-extraction-fixtures.mjs <owner-records-predictions.json>. Offline scoring only; no OCR/provider calls.");
  process.exitCode = 2;
} else {
  try {
    if ((await stat(filename)).size > 2 * 1024 * 1024) throw new Error("Prediction file exceeds 2 MiB.");
    const manifest = JSON.parse(await readFile(new URL("../tests/fixtures/everyday-records/ground-truth.json", import.meta.url), "utf8"));
    const predictions = JSON.parse(await readFile(filename, "utf8"));
    const result = scoreExtraction(manifest, predictions);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    console.error("Evaluation failed: supply a valid bounded predictions JSON object using the documented owner-records contract.");
    process.exitCode = 2;
  }
}
