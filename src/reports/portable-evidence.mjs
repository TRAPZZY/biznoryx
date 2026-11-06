import { createHash } from "node:crypto";

const reportFields = [
  "version", "id", "sourceId", "seriesKey", "organizationName", "title", "generatedAt",
  "metric", "current", "previous", "comparison", "timeline", "daily", "drivers",
  "heatmap", "trend", "executive", "health", "priorities", "strengths", "evidenceQuality",
  "limitations", "revenueBreakdown", "evidence", "explainer",
];

export function createPortableEvidenceFile(report) {
  // Allowlist the selected report, not navigation choices or future runtime fields.
  const snapshot = JSON.parse(JSON.stringify(Object.fromEntries(
    reportFields.filter(key => Object.hasOwn(report, key)).map(key => [key, report[key]]),
  )));
  const payload = {
    schemaVersion: "biznoryx.evidence-file.v1",
    report: snapshot,
    scope: {
      originalFilesIncluded: false,
      actionsAndOutcomesIncluded: false,
      externalCertification: false,
      integrityLimitations: "This checksum is not a digital signature, identity verification, financial audit or creditworthiness assessment. It detects changes only relative to a trusted copy of the checksum.",
    },
  };
  return {
    payload,
    integrity: {
      algorithm: "SHA-256",
      serialization: "JSON.stringify(payload)",
      value: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
    },
  };
}
