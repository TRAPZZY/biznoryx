import { parseReportNumber } from "../../src/reports/decimal.mjs";

export function expectedFields(manifest, fixture) {
  return fixture.inheritsFieldsFrom ? manifest.cases.find(item => item.fixtureId === fixture.inheritsFieldsFrom).fields : fixture.fields;
}

export function scoreExtraction(manifest, predictions) {
  const supplied = predictions?.cases;
  if (!Array.isArray(supplied) || supplied.length > 100 || supplied.some(item =>
    !item || typeof item.fixtureId !== "string" || !item.fields || typeof item.fields !== "object" || Array.isArray(item.fields) ||
    !Array.isArray(item.requiredReviewDecisions) || !item.requiredReviewDecisions.every(value => typeof value === "string") ||
    (item.claims != null && (!Array.isArray(item.claims) || !item.claims.every(value => typeof value === "string"))) ||
    (item.relationships != null && (!Array.isArray(item.relationships) || item.relationships.some(value =>
      !value || !Array.isArray(value.fixtureIds) || !value.fixtureIds.every(id => typeof id === "string")))))) {
    throw new TypeError("Predictions must contain at most 100 structured case results.");
  }
  const cases = manifest.cases.map(expected => {
    const matches = supplied.filter(item => item.fixtureId === expected.fixtureId);
    const actual = matches.length === 1 ? matches[0] : null;
    const expectedValues = expectedFields(manifest, expected);
    const errors = [];
    let correctFields = 0;
    if (!actual) errors.push(matches.length > 1 ? "duplicate_fixture_result" : "missing_fixture_result");
    if (actual?.recordType !== expected.recordType) errors.push("record_type");
    for (const [key, field] of Object.entries(expectedValues)) {
      const proposed = actual?.fields?.[key];
      let equal = proposed && proposed.provenance === field.provenance;
      if (field.type === "decimal") {
        equal &&= typeof proposed.value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(proposed.value) && parseReportNumber(proposed.value) !== null && parseReportNumber(proposed.value) === parseReportNumber(field.value);
      } else equal &&= proposed.value === field.value;
      if (equal) correctFields++;
      else errors.push(`${field.provenance === "unknown" && proposed?.value != null ? "unsafe_guess" : "field"}:${key}`);
      if (field.candidates && (!Array.isArray(proposed?.candidates) || field.candidates.length !== proposed.candidates.length ||
        field.candidates.some(value => !proposed.candidates.some(candidate => typeof candidate === "string" && parseReportNumber(candidate) === parseReportNumber(value))))) errors.push(`missing_ambiguity_candidates:${key}`);
    }
    for (const key of Object.keys(actual?.fields || {})) if (!Object.hasOwn(expectedValues, key)) errors.push(`unexpected_field:${key}`);
    for (const review of expected.requiredReviewDecisions) if (!actual?.requiredReviewDecisions?.includes(review)) errors.push(`missing_review:${review}`);
    for (const claim of actual?.claims || []) if (expected.prohibitedClaims.includes(claim)) errors.push(`prohibited_claim:${claim}`);
    for (const relationship of expected.relationships) {
      const candidate = actual?.relationships?.find(item => item.kind === relationship.kind && item.requiresReview === true &&
        relationship.fixtureIds.some(id => item.fixtureIds?.includes(id)));
      if (!candidate) errors.push(`missing_relationship_review:${relationship.kind}`);
    }
    if (actual?.importApproved === true) errors.push("synthetic_or_unconfirmed_import");
    return { fixtureId: expected.fixtureId, passed: errors.length === 0, correctFields, totalFields: Object.keys(expectedValues).length, errors };
  });
  const unknownIds = supplied.filter(item => !manifest.cases.some(expected => expected.fixtureId === item.fixtureId)).map(item => item.fixtureId);
  return { syntheticOnly: true, provesRealWorldAccuracy: false, extractionExecutedByScorer: false,
    passed: cases.every(item => item.passed) && !unknownIds.length, cases, unknownFixtureIds: unknownIds };
}

export function possibleDuplicateCaptures(proposals) {
  const candidates = [];
  const normalize = value => typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
  for (let index = 0; index < proposals.length; index++) {
    const left = proposals[index];
    for (const right of proposals.slice(index + 1)) {
      if (!left.receiptId || !left.supplier || !left.date || !left.currency ||
          ![left.total, right.total].every(value => typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value))) continue;
      if (parseReportNumber(left.total) === null || parseReportNumber(right.total) === null) continue;
      if (["receiptId", "supplier", "date", "currency"].every(key => normalize(left[key]) === normalize(right[key])) &&
          parseReportNumber(left.total) === parseReportNumber(right.total)) {
        candidates.push({ captureIds: [left.captureId, right.captureId], reason: "same_supplier_receipt_date_currency_total", requiresReview: true, importApproved: false });
      }
    }
  }
  return candidates;
}
