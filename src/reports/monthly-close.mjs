import { createHash } from "node:crypto";
import { AuthError } from "../auth/core.mjs";
import { REPORT_VERSION } from "./evidence-engine.mjs";

export const MONTHLY_CLOSE_SCHEMA = "biznoryx.monthly-close.v1";
export const MAX_MONTHLY_CLOSE_BYTES = 2 * 1024 * 1024;
const DECIMAL = /^-?\d{1,28}(?:\.\d{1,10})?$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BLOCKING_CODES = new Set([
  "MAPPING_UNCONFIRMED",
  "PARTIAL_PERIOD",
  "INVALID_DATES",
  "MISSING_METRIC",
  "SCHEMA_DRIFT",
  "OVERLAPPING_SOURCE",
  "DECLARED_PERIOD_MISMATCH",
]);

export function monthlyCloseError(message, code = "VALIDATION_FAILED") {
  return new AuthError(message, code);
}

export function validateClosePeriod(period) {
  if (
    typeof period !== "string" ||
    !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(period)
  )
    throw monthlyCloseError("Choose a reporting period in YYYY-MM format.");
  return period;
}

export function validateCloseId(id) {
  if (typeof id !== "string" || !UUID.test(id))
    throw monthlyCloseError("Monthly close identifier is invalid.");
  return id;
}

// Sorted object keys, original array order, finite JSON primitives only. This
// serialization is versioned with the packet; JSONB object order is irrelevant.
export function canonicalJson(value) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  function encode(item, depth) {
    if (++nodes > 100000 || depth > 32)
      throw monthlyCloseError(
        "Monthly close exceeds its JSON depth or node budget.",
      );
    let result;
    if (item === null || typeof item === "boolean") result = String(item);
    else if (typeof item === "string") {
      if (item.includes("\u0000") || item.length > 65536)
        throw monthlyCloseError(
          "Monthly close string exceeds its size budget or contains a null character.",
        );
      result = JSON.stringify(item);
    } else if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      (!Number.isInteger(item) || Number.isSafeInteger(item))
    )
      result = JSON.stringify(item);
    else if (
      typeof item === "object" &&
      item &&
      !seen.has(item) &&
      (Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null)
    ) {
      seen.add(item);
      if (Object.getOwnPropertySymbols(item).length)
        throw monthlyCloseError("Monthly close must contain JSON values only.");
      const keys = Object.keys(item);
      if (
        keys.some(
          (key) =>
            !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), "value"),
        )
      )
        throw monthlyCloseError(
          "Monthly close must contain plain JSON values only.",
        );
      result = Array.isArray(item)
        ? `[${Array.from(item, (entry) => encode(entry, depth + 1)).join(",")}]`
        : `{${keys
            .sort()
            .map(
              (key) =>
                `${encode(key, depth + 1)}:${encode(item[key], depth + 1)}`,
            )
            .join(",")}}`;
      seen.delete(item);
      return result;
    } else
      throw monthlyCloseError(
        "Monthly close must contain bounded, finite JSON values only.",
      );
    bytes += Buffer.byteLength(result, "utf8");
    if (bytes > MAX_MONTHLY_CLOSE_BYTES)
      throw monthlyCloseError("Monthly close exceeds its JSON size budget.");
    return result;
  }
  const result = encode(value, 0);
  if (Buffer.byteLength(result, "utf8") > MAX_MONTHLY_CLOSE_BYTES)
    throw monthlyCloseError("Monthly close exceeds its JSON size budget.");
  return result;
}

export function monthlyCloseHash(packet) {
  return createHash("sha256")
    .update(canonicalJson(packet), "utf8")
    .digest("hex");
}

export function buildMonthlyClosePacket({
  period,
  report,
  limitations = [],
  supersedesId = null,
}) {
  validateClosePeriod(period);
  if (supersedesId !== null) validateCloseId(supersedesId);
  // Snapshot only the evidence report, excluding cross-source navigation.
  canonicalJson(report);
  if (
    report?.version !== REPORT_VERSION ||
    report?.current?.period !== period ||
    !report.metric ||
    !report.evidence
  )
    throw monthlyCloseError(
      "A server-built evidence report for this period is required.",
    );
  const snapshot = structuredClone(report);
  delete snapshot.controls;
  if (
    typeof snapshot.current.value !== "string" ||
    !DECIMAL.test(snapshot.current.value)
  )
    throw monthlyCloseError(
      "Verified metric values must be exact decimal strings.",
    );
  validateDecimalValues(snapshot);
  const sources = snapshot.evidence.sources;
  if (!Array.isArray(sources) || !sources.length || sources.length > 240)
    throw monthlyCloseError(
      "Source provenance is required for every monthly close.",
    );
  for (const source of sources) {
    for (const key of ["id", "rawDataObjectId", "metricPointId"])
      validateCloseId(source[key]);
    if (
      !/^[a-f0-9]{64}$/.test(source.checksum) ||
      !Number.isSafeInteger(source.rowCount) ||
      source.rowCount < 0
    )
      throw monthlyCloseError(
        "Source checksum and row-count provenance are required.",
      );
  }
  if (
    !Array.isArray(limitations) ||
    limitations.length > 100 ||
    !Array.isArray(snapshot.limitations) ||
    snapshot.limitations.length > 100
  )
    throw monthlyCloseError("Monthly close limitations are invalid.");
  const combined = [
    ...snapshot.limitations,
    ...limitations,
    {
      code: "NO_CASH_RECONCILIATION",
      message:
        "Any sales and receipts snapshot reflects reviewed source allocations as of preparation. This does not establish complete cash or bank reconciliation.",
    },
  ];
  for (const item of combined) {
    if (
      !item ||
      typeof item.code !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(item.code) ||
      typeof item.message !== "string" ||
      !item.message.trim() ||
      item.message.length > 2000
    )
      throw monthlyCloseError(
        "Each limitation needs a bounded code and explanation.",
      );
  }
  const packet = {
    schemaVersion: MONTHLY_CLOSE_SCHEMA,
    period,
    supersedesId,
    report: snapshot,
    evidenceManifest: {
      schemaVersion: "biznoryx.monthly-close-evidence.v1",
      reportVersion: snapshot.version,
      calculation: snapshot.evidence.calculation,
      aggregation: snapshot.evidence.aggregation,
      dateColumn: snapshot.evidence.dateColumn,
      mappingVersion: snapshot.evidence.mappingVersion,
      definition: snapshot.metric.policy,
      sourceRows: snapshot.evidence.sourceRows,
      contributingRows: snapshot.evidence.contributingRows,
      sources: structuredClone(sources),
      importProfiles: snapshot.evidence.importProfiles ?? [],
      sourceChecklist: snapshot.evidence.sourceChecklist ?? {
        confirmed: false,
        version: 0,
        period,
        sources: [],
      },
      moneyTrail: snapshot.evidence.moneyTrail ?? null,
      coverage: {
        period,
        rows: snapshot.current.rows,
        partial: snapshot.current.partial,
        first: snapshot.current.first,
        last: snapshot.current.last,
        observedDays: snapshot.current.observedDays,
      },
      evidenceScope:
        "Supplied source records only; completeness of all business activity is not established.",
      externalCertification: false,
    },
    limitations: [
      ...new Map(
        combined.map((item) => [
          item.code,
          { code: item.code, message: item.message },
        ]),
      ).values(),
    ],
  };
  return JSON.parse(canonicalJson(packet));
}

function validateDecimalValues(value, key = "") {
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) validateDecimalValues(item);
    return;
  }
  if (typeof value === "object") {
    for (const [name, item] of Object.entries(value))
      validateDecimalValues(item, name);
    return;
  }
  if (
    ["value", "absoluteChange", "change", "revenue", "quantity"].includes(
      key,
    ) &&
    (typeof value !== "string" || !DECIMAL.test(value))
  )
    throw monthlyCloseError(
      "Verified metric values must be exact decimal strings.",
    );
}

export function approvalBlockers(packet) {
  const { report, evidenceManifest, limitations } = packet;
  const blockers = new Set(
    limitations
      .filter((item) => BLOCKING_CODES.has(item.code))
      .map((item) => item.code),
  );
  if (
    !evidenceManifest.sourceChecklist?.confirmed ||
    !evidenceManifest.sourceChecklist.sources?.length
  )
    blockers.add("SOURCE_CHECKLIST_UNCONFIRMED");
  else if (
    evidenceManifest.sourceChecklist.sources.some((s) => s.status !== "ready")
  )
    blockers.add("REQUIRED_SOURCE_NOT_READY");
  if (
    evidenceManifest.moneyTrail?.hasMoreRecords ||
    evidenceManifest.moneyTrail?.hasMoreAllocations
  )
    blockers.add("FINANCIAL_EVIDENCE_LIMIT");
  const policy = report.metric.policy;
  if (
    !policy ||
    !Number.isSafeInteger(policy.version) ||
    policy.version < 1 ||
    !UUID.test(policy.approvedByUserId ?? "") ||
    evidenceManifest.mappingVersion !== policy.version
  )
    blockers.add("MAPPING_UNCONFIRMED");
  if (
    !Number.isSafeInteger(report.current.rows) ||
    report.current.rows < 1 ||
    typeof report.current.value !== "string" ||
    !DECIMAL.test(report.current.value)
  )
    blockers.add("EMPTY_METRICS");
  if (
    report.current.partial ||
    report.evidenceQuality?.level === "limited_evidence"
  )
    blockers.add("INCOMPLETE_COVERAGE");
  return [...blockers].sort();
}
