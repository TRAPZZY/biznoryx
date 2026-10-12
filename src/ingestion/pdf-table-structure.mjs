import { parse } from "csv-parse/sync";

export const PDF_TABLE_VERSION = "pdf-text-table-v1";
export const PDF_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, pages: 50, textBytes: 2 * 1024 * 1024, rows: 10000, columns: 32 });

const measure = /^(?:revenue|sales|amount|cost|expense|expenses|profit|quantity|units|debit|credit)$/i;
const decimal = /^-?\d{1,18}(?:\.\d{1,4})?$/;

// Only explicit table cells are accepted. No OCR, prose-to-record inference,
// subtotal removal, date coercion or missing-value completion takes place.
export function tableFromPdfPages(pages) {
  let headers;
  let delimiter;
  const rows = [];
  const pageRanges = [];
  let textBytes = 0;
  if (!Array.isArray(pages) || !pages.length || pages.length > PDF_LIMITS.pages) fail("The PDF must contain 1 to 50 pages.");
  for (const [pageIndex, page] of pages.entries()) {
    const text = String(page.text ?? "");
    textBytes += Buffer.byteLength(text, "utf8");
    if (textBytes > PDF_LIMITS.textBytes) fail("The extracted PDF table exceeds the 2 MiB text limit.");
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) fail("The PDF contains an unreadable or scanned page. Export a text table or CSV; OCR is not enabled.");
    delimiter ??= lines[0].includes("\t") ? "\t" : ",";
    const records = page.table ? page.table.map(row => row.map(cell => String(cell).trim())) : lines.map(line => {
      try {
        const parsed = parse(line, { delimiter, trim: true, relax_column_count: false, max_record_size: 16384 });
        if (parsed.length !== 1) fail("The PDF contains an ambiguous table row.");
        return parsed[0];
      } catch { fail("The PDF contains an unreadable table row. Export the source as CSV."); }
    });
    const pageHeader = records.shift();
    if (!headers) {
      headers = pageHeader;
      if (headers.length < 2 || headers.length > PDF_LIMITS.columns || headers.some(header => !/^[a-zA-Z][a-zA-Z0-9 _-]{0,79}$/.test(header)) || new Set(headers.map(header => header.toLowerCase())).size !== headers.length || !headers.some(header => measure.test(header))) {
        fail("Use a PDF table with unique column names and an explicit numeric measure such as revenue, amount or quantity.");
      }
    } else if (JSON.stringify(headers) !== JSON.stringify(pageHeader)) {
      fail("Every PDF page must start with the same table header. Mixed tables or schema changes require separate files.");
    }
    if (!records.length) fail("Every PDF page must contain data rows below its table header.");
    const firstDataRow = rows.length + 1;
    for (const row of records) {
      if (row.length !== headers.length || row.some(cell => !cell || Buffer.byteLength(cell, "utf8") > 4096 || /[\x00-\x1f]/.test(cell))) fail("The PDF has missing, wrapped or inconsistent cells. Export the source as CSV.");
      if (row.some(cell => /^(?:(?:grand|sub|opening|closing)\s*)?total(?:s)?(?:\b|:)|^(?:opening|closing)\s+balance\b/i.test(cell))) fail("PDF tables containing totals or balance-summary rows are ambiguous. Export transaction rows only.");
      for (const [index, header] of headers.entries()) {
        if (measure.test(header) && !decimal.test(row[index])) fail("PDF numeric cells must be explicit decimals without currency symbols or thousands separators. No values were inferred.");
        if (/^(?:date|transaction date|sale date)$/i.test(header)) {
          const value = row[index];
          const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T00:00:00Z") : null;
          if (!date || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail("PDF dates must be valid YYYY-MM-DD values. Ambiguous date formats require a CSV export.");
        }
      }
      rows.push(row);
      if (rows.length > PDF_LIMITS.rows) fail("The PDF exceeds the limit of 10,000 data rows.");
    }
    pageRanges.push({ page: pageIndex + 1, firstDataRow, lastDataRow: rows.length });
  }
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  return { csv: [headers, ...rows].map(row => row.map(quote).join(",")).join("\n"), rowCount: rows.length, pageRanges, parserVersion: PDF_TABLE_VERSION };
}

function fail(message) { throw new Error(message); }
