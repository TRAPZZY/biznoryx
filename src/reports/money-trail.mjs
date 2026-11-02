/** Money Trail v1: exact NGN records. This module never extracts or guesses source meaning. */
export class MoneyTrailError extends Error {
  constructor(message, code = "MONEY_TRAIL_INVALID_INPUT") {
    super(message);
    this.name = "MoneyTrailError";
    this.code = code;
  }
}

export const MONEY_TRAIL_LIMITS = Object.freeze({
  importRecords: 1000,
  records: 500,
  allocations: 500,
  suggestions: 100,
});
const KINDS = new Set([
  "sale",
  "receipt",
  "owner_movement",
  "unknown",
  "credit",
  "refund",
]);

export function decimalMoney(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(value)
  ) {
    throw new MoneyTrailError(
      "Amount must be positive NGN decimal text with at most 16 integer digits and two decimal places.",
    );
  }
  const [whole, fraction = ""] = value.split(".");
  const result = `${whole}.${fraction.padEnd(2, "0")}`;
  if (result === "0.00")
    throw new MoneyTrailError("Amount must be greater than zero.");
  return result;
}

export function moneyTrailText(value, name, maximum, required = false) {
  if (value === undefined || value === null) value = "";
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value) ||
    (required && !value.trim())
  ) {
    throw new MoneyTrailError(
      `${name} must be ${required ? "nonempty " : ""}text (maximum ${maximum} characters, no control characters).`,
    );
  }
  return value;
}

function isoDate(value, name) {
  if (
    typeof value !== "string" ||
    !/^(19|20|21)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new MoneyTrailError(
      `${name} must be a valid explicit ISO calendar date (1900–2199).`,
    );
  }
  return value;
}

function meaning(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !KINDS.has(input.kind)
  )
    throw new MoneyTrailError("Select an explicit record kind.");
  if (input.currency !== undefined && input.currency !== "NGN")
    throw new MoneyTrailError("Only NGN is supported.");
  const paymentStatus = input.paymentStatus ?? "unknown";
  if (
    !["unknown", "confirmed_receivable"].includes(paymentStatus) ||
    (paymentStatus === "confirmed_receivable" && input.kind !== "sale")
  ) {
    throw new MoneyTrailError(
      "Only a sale can be explicitly confirmed as a receivable.",
    );
  }
  const dueDate =
    input.dueDate == null ? null : isoDate(input.dueDate, "Due date");
  if (dueDate && paymentStatus !== "confirmed_receivable")
    throw new MoneyTrailError(
      "An explicit due date requires a confirmed receivable.",
    );
  if (
    input.referenceConfirmed !== undefined &&
    typeof input.referenceConfirmed !== "boolean"
  )
    throw new MoneyTrailError("Reference confirmation must be a boolean.");
  return {
    kind: input.kind,
    paymentStatus,
    dueDate,
    referenceConfirmed: input.referenceConfirmed ?? false,
  };
}

export function normalizeMoneyRecord(input) {
  const classification = meaning(input);
  const reference = moneyTrailText(input.reference, "Reference", 180);
  if (classification.referenceConfirmed && !reference.trim())
    throw new MoneyTrailError("An empty reference cannot be confirmed.");
  return {
    sourceRowLocator: moneyTrailText(
      input.sourceRowLocator,
      "Original source row locator",
      300,
      true,
    ),
    date: isoDate(input.date, "Record date"),
    reference,
    description: moneyTrailText(input.description, "Description", 2000),
    amount: decimalMoney(input.amount),
    currency: "NGN",
    ...classification,
  };
}

export function normalizeClassification(input) {
  return {
    ...meaning(input),
    reason: moneyTrailText(input.reason, "Review reason", 1000, true),
  };
}

export function moneyTrailPeriod(period) {
  if (period === undefined || period === null)
    return { period: null, start: null, endExclusive: null };
  if (
    typeof period !== "string" ||
    !/^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$/.test(period)
  )
    throw new MoneyTrailError("Period must be YYYY-MM (1900–2199).");
  const next = new Date(`${period}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return {
    period,
    start: `${period}-01`,
    endExclusive: next.toISOString().slice(0, 10),
  };
}

/**
 * Consumer contract: totals are complete even when detail lists are capped.
 * period scopes recordedSales/customerReceipts/credits/refunds by their actual
 * record dates. allocatedReceipts/confirmedCredits/allocatedRefunds and balances
 * describe selected sales using ALL currently reviewed allocations, including
 * later receipts. These are live balances, never a frozen historical close.
 * A monthly packet must persist this result and its allocation/reversal evidence.
 * Refund allocations explicitly reopen a balance; credits reduce balances but
 * never increase cash receipts. Unknown sales never become confirmed debt.
 */
export function moneyTrailReport(input) {
  return {
    currency: "NGN",
    period: input.period ?? null,
    asOf: input.asOf ?? new Date().toISOString(),
    balanceBasis:
      "Selected sales with approved allocations across all dates; live reviewed balances, not a historical close.",
    records: input.records ?? [],
    allocations: input.allocations ?? [],
    suggestions: input.suggestions ?? [],
    sourceCorrections: input.sourceCorrections ?? [],
    totals: input.totals ?? {},
    reviewCounts: input.reviewCounts ?? {},
    recordCount: input.recordCount ?? 0,
    hasMoreRecords: (input.recordCount ?? 0) > MONEY_TRAIL_LIMITS.records,
    hasMoreAllocations: input.hasMoreAllocations ?? false,
    hasMoreSuggestions: input.hasMoreSuggestions ?? false,
    limitations: [
      "Recorded sales are not profit.",
      "Missing payment evidence does not establish an unpaid or overdue balance.",
      "Source completeness has not been established.",
    ],
  };
}
