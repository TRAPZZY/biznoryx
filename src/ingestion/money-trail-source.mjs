import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { AuthError } from "../auth/core.mjs";
import { normalizeMoneyRecord } from "../reports/money-trail.mjs";

// Input is the verified worker artifact and its approved profile, never rows
// supplied in an HTTP request. No date locale or payment status is inferred.
export function financialSourcePreview({
  body,
  profile,
  sourceChecksum,
  profileId,
}) {
  if (profile.currency !== "NGN")
    throw new AuthError(
      "Money Trail currently supports confirmed NGN sources. No currency conversion has been performed.",
      "VALIDATION_FAILED",
    );
  if (!["sales", "receipts"].includes(profile.sourceRole))
    throw new AuthError(
      "Approve a sales or customer-receipts mapping before using Money Trail.",
      "VALIDATION_FAILED",
    );
  const rows = parse(body, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    columns: false,
    relax_column_count: false,
    max_record_size: 1024 * 1024,
    to: 1002,
  });
  if (rows.length > 1001)
    throw new AuthError(
      "Money Trail review accepts up to 1,000 records per source. Split this source into reviewed reporting series before importing.",
      "VALIDATION_FAILED",
    );
  const headers = rows.shift();
  if (
    !headers ||
    headers.length !== profile.columns.length ||
    headers.some((name, i) => name !== profile.columns[i])
  )
    throw new AuthError(
      "Source columns differ from the approved mapping.",
      "VALIDATION_FAILED",
    );
  const column = Object.fromEntries(
    Object.entries(profile.mapping).map(([key, name]) => [
      key,
      headers.indexOf(name),
    ]),
  );
  const records = [],
    issues = [];
  rows.forEach((row, i) => {
    try {
      const read = (key) =>
        column[key] === undefined ? "" : String(row[column[key]] ?? "").trim();
      const amount = read("amount");
      if (
        !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)
      )
        throw new Error(
          "Amount must be a positive NGN amount with at most two decimal places.",
        );
      const record = normalizeMoneyRecord({
        sourceRowLocator: `record:${i + 2}`,
        date: financialDate(read("date"), profile.dateConvention),
        amount: amount.replaceAll(",", ""),
        kind: profile.sourceRole === "sales" ? "sale" : "receipt",
        currency: "NGN",
        reference: read("reference"),
        description: read("description"),
        paymentStatus: "unknown",
        referenceConfirmed: false,
      });
      records.push(record);
    } catch (error) {
      issues.push({ row: i + 2, column: null, message: error.message });
    }
  });
  const checksum = createHash("sha256")
    .update(JSON.stringify({ sourceChecksum, profileId, records, issues }))
    .digest("hex");
  return {
    records,
    issues,
    rowCount: rows.length,
    checksum,
    reviewRequired: true,
    limitations: [
      "No unpaid balance or due date is inferred. Review each sale before confirming a receivable.",
      "References require separate confirmation before match suggestions.",
    ],
  };
}

export function financialDate(value, convention) {
  let date = value;
  if (convention !== "ISO") {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
    if (!match)
      throw new Error(
        "Use a four-digit year and the approved date convention.",
      );
    const day = convention === "DMY" ? match[1] : match[2],
      month = convention === "DMY" ? match[2] : match[1];
    date = `${match[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error(
      "The record date is invalid or differs from the approved date convention.",
    );
  return date;
}
