import { parse } from "csv-parse/sync";
import { AuthError } from "../auth/core.mjs";
import { financialDate } from "./money-trail-source.mjs";

export function applyImportProfile(parsed, definition) {
  const names = parsed.columns.map((c) => c.name);
  if (JSON.stringify(names) !== JSON.stringify(definition.columns))
    throw new AuthError(
      "The source columns changed. Review and approve the mapping again.",
      "VALIDATION_FAILED",
    );
  const dateColumn = definition.mapping.date;
  if (!dateColumn) return { ...parsed, normalization: {} };
  const records = parse(parsed.normalizedContent, {
    bom: true,
    skip_empty_lines: true,
    trim: true,
    max_record_size: 1024 * 1024,
  });
  const index = names.indexOf(dateColumn),
    issues = [];
  let changed = false;
  for (let i = 1; i < records.length; i++) {
    try {
      const iso = financialDate(records[i][index], definition.dateConvention);
      if (iso !== records[i][index]) changed = true;
      records[i][index] = iso;
    } catch (error) {
      issues.push({ row: i + 1, column: dateColumn, message: error.message });
      if (issues.length >= 100) break;
    }
  }
  if (issues.length) {
    const error = new AuthError(
      "Some dates do not match the approved convention. Correct the listed source records.",
      "VALIDATION_FAILED",
    );
    error.issues = issues;
    throw error;
  }
  const cell = (value) =>
    /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return {
    ...parsed,
    normalizedContent: changed
      ? records.map((r) => r.map(cell).join(",")).join("\n") + "\n"
      : parsed.normalizedContent,
    columns: parsed.columns.map((c) =>
      c.name === dateColumn
        ? {
            ...c,
            type: "date",
            dataType: "date",
            required: true,
            nullable: false,
          }
        : c,
    ),
    normalization: {
      dateConvention: "ISO",
      dateColumn,
      version: "approved-dates/1",
    },
  };
}
