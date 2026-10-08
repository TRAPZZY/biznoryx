import { AuthError } from "../auth/core.mjs";
import { createRawObjectIdentity } from "./raw-object-identity.mjs";

export const MANUAL_ENTRY_LIMITS = Object.freeze({
  rows: 50_000, columns: 200, cells: 1_000_000,
  bytes: 25 * 1024 * 1024, cellBytes: 32 * 1024,
});

export const SALES_COLUMNS = Object.freeze([
  { name: "date", type: "date", required: true },
  { name: "product", type: "text", required: true },
  { name: "quantity", type: "decimal", required: true },
  { name: "revenue", type: "decimal", required: true },
]);

export class ManualEntryError extends AuthError {
  constructor(message, code = "VALIDATION_FAILED", issues = []) {
    super(message, code);
    this.issues = issues;
  }
}

export class ManualEntryService {
  constructor({ repository, objectStorage }) {
    if (!repository || !objectStorage) throw new TypeError("Repository and object storage are required.");
    this.repository = repository;
    this.objectStorage = objectStorage;
  }

  load(input) { return this.repository.load(input); }
  saveDraft(input) { return this.repository.saveDraft(input); }
  validateDraft(input) { return this.repository.validateDraft(input); }

  async submit(input) {
    const prepared = await this.repository.prepareSubmission(input);
    if (prepared.upload) return prepared;
    const { snapshotCsv, fileName, organizationId } = prepared.submission;
    const identity = createRawObjectIdentity({ organizationId, originalFilename: fileName, content: snapshotCsv });
    const head = await this.objectStorage.headObject({ key: identity.storageKey });
    if (!head.exists) {
      await this.objectStorage.putObject({
        key: identity.storageKey, body: Buffer.from(snapshotCsv, "utf8"), contentType: "text/csv",
        metadata: { organization: organizationId, checksum: identity.checksumSha256 },
      });
    }
    // The reservation and bytes survive failures; retry the same draft/version.
    return this.repository.finalizeSubmission({ ...input, submissionId: prepared.submission.id });
  }
}

export function monthlyPeriod(period) {
  if (typeof period !== "string" || !/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(period)) {
    throw new ManualEntryError("Period must be a valid YYYY-MM month (1900-2199).");
  }
  const [year, month] = period.split("-").map(Number);
  return {
    periodStart: `${period}-01`,
    periodEnd: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    label: period,
  };
}

export function assertGridLimits(rows, columns) {
  if (!Array.isArray(columns) || !columns.length || columns.length > MANUAL_ENTRY_LIMITS.columns ||
      !Array.isArray(rows) || rows.length > MANUAL_ENTRY_LIMITS.rows ||
      rows.length * columns.length > MANUAL_ENTRY_LIMITS.cells) {
    throw new ManualEntryError("Spreadsheet exceeds row, column or cell limits.", "MANUAL_LIMIT_EXCEEDED");
  }
  let bytes = Buffer.byteLength(JSON.stringify(columns), "utf8");
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw new ManualEntryError("Every row must match the series column count.");
    for (const cell of row) {
      if (typeof cell !== "string") throw new ManualEntryError("Cell values must be strings.");
      const size = Buffer.byteLength(cell, "utf8");
      if (size > MANUAL_ENTRY_LIMITS.cellBytes) throw new ManualEntryError("A cell exceeds 32 KiB.", "MANUAL_LIMIT_EXCEEDED");
      bytes += Buffer.byteLength(JSON.stringify(cell), "utf8") + 1;
      if (bytes > MANUAL_ENTRY_LIMITS.bytes) throw new ManualEntryError("Spreadsheet exceeds 25 MiB.", "MANUAL_LIMIT_EXCEEDED");
    }
    bytes += 2;
  }
}

export function validateGrid({ columns, rows, period, entryDate = null }) {
  monthlyPeriod(period);
  assertGridLimits(rows, columns);
  const issues = [];
  const add = (row, column, code, message) => {
    if (issues.length < 1000) issues.push({ row, column, code, message });
  };
  if (!rows.length) add(null, null, "EMPTY_GRID", "Enter at least one row.");
  const dateColumn = columns.findIndex((column) => column.type === "date");
  if (dateColumn < 0 && (!validDate(entryDate) || !entryDate.startsWith(`${period}-`))) {
    add(null, null, "ENTRY_DATE_INVALID", "A valid entryDate in this month is required for a series without a date column.");
  }
  const populated = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some((cell) => cell.trim()));
  if (rows.length && !populated.length) add(null, null, "EMPTY_GRID", "Enter at least one row.");
  const normalizedRows = populated.map(({ row, index }) => row.map((cell, columnIndex) => {
    const column = columns[columnIndex];
    const value = column.type === "text" ? cell : cell.trim();
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) add(index + 1, columnIndex + 1, "CONTROL_CHARACTER", "Cell contains unsupported control characters.");
    if (!value.trim()) {
      if (column.required) add(index + 1, columnIndex + 1, "REQUIRED", "Value is required.");
      return "";
    }
    switch (column.type) {
      case "date":
        if (!validDate(value)) add(index + 1, columnIndex + 1, "DATE_INVALID", "Use a real date in YYYY-MM-DD format.");
        else if (!value.startsWith(`${period}-`)) add(index + 1, columnIndex + 1, "DATE_OUTSIDE_PERIOD", "Date must belong to the draft month.");
        break;
      case "decimal": case "number": case "numeric":
        if (!/^-?\d{1,28}(?:\.\d{1,10})?$/.test(value)) add(index + 1, columnIndex + 1, "DECIMAL_INVALID", "Use a decimal with up to 28 integer and 10 fractional digits, without grouping or exponents.");
        break;
      case "integer":
        if (!/^-?\d{1,28}$/.test(value)) add(index + 1, columnIndex + 1, "INTEGER_INVALID", "Use a whole number with up to 28 digits.");
        break;
      case "boolean":
        if (!["true", "false", "yes", "no"].includes(value.toLowerCase())) add(index + 1, columnIndex + 1, "BOOLEAN_INVALID", "Use true, false, yes or no.");
        return value.toLowerCase();
      case "text": break;
      default: add(index + 1, columnIndex + 1, "UNSUPPORTED_COLUMN_TYPE", `Manual entry does not support type ${column.type}.`);
    }
    return value;
  }));
  if (dateColumn >= 0) {
    populated.forEach(({ row, index }) => {
      if (!row[dateColumn].trim()) add(index + 1, dateColumn + 1, "ENTRY_DATE_REQUIRED", "Each daily entry requires a date.");
    });
  }
  return { valid: issues.length === 0, issues, rowCount: populated.length, normalizedRows };
}

export function canonicalMonthlyCsv(columns, rows) {
  assertGridLimits(rows, columns);
  const escape = (value, type) => {
    // Numeric negatives stay numeric. Text and headers are safe to open in Excel.
    const safe = (type === "text" && /^[\s]*[=+@-]/.test(value)) || /^[\t\r\n]/.test(value)
      ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const csv = [columns.map((column) => escape(column.name, "text")).join(","),
    ...rows.map((row) => row.map((cell, index) => escape(cell, columns[index].type)).join(","))].join("\r\n") + "\r\n";
  if (Buffer.byteLength(csv, "utf8") > MANUAL_ENTRY_LIMITS.bytes) throw new ManualEntryError("CSV snapshot exceeds 25 MiB.", "MANUAL_LIMIT_EXCEEDED");
  return csv;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
