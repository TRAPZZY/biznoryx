import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { AuthError } from "../auth/core.mjs";
import { validateCsvHeaderSizes } from "./csv-limits.mjs";

const require = createRequire(import.meta.url);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_XLSX_BYTES = 2 * 1024 * 1024;
const csvPackage = require(
  resolve(dirname(require.resolve("csv-parse/sync")), "../../package.json"),
);
const PARSER_VERSION = `tabular-upload/1;csv-parse@${csvPackage.version}`;
let activeXlsx = false;

/**
 * Normalize an untrusted upload without storage, database, network or business
 * interpretation. Exactly one content source is required. XLSX requires binary
 * Buffer content or canonical padded base64; CSV also accepts a UTF-8 string.
 * `sheet` is an exact sheet name or a one-based integer, never a guessed choice.
 * CSV bytes are immutable evidence; metadata describes the existing CSV parser
 * semantics but normalizedContent is the untouched original string.
 *
 * XLSX policy v1: plain tabular worksheets only. Reject formulas (including
 * cached results), error cells, macros, external relationships, merged cells,
 * binary parts and date-valued cells. Date serials need a later approved profile;
 * date-like text is preserved without locale inference. Text is never evaluated.
 * Output CSV remains untrusted data, not a spreadsheet-safe export.
 *
 * @param {{fileName: string, content?: string|Buffer, contentBase64?: string, sheet?: string|number}} input
 * @returns {Promise<{originalBytes: Buffer, originalContentType: string, normalizedContent: string,
 * columns: Array<{name: string, type: string, required: boolean, dataType: string, nullable: boolean}>, rowCount: number,
 * format: string, sheets?: string[], selectedSheet?: string, parserVersion: string}>}
 */
export async function normalizeTabularUpload(input = {}) {
  if (!input || typeof input !== "object") fail("Upload content is required.");
  const { fileName, content, contentBase64, sheet } = input;
  if (
    typeof fileName !== "string" ||
    !fileName.trim() ||
    /[\\/\x00-\x1f]/.test(fileName) ||
    Buffer.byteLength(fileName, "utf8") > 255
  )
    fail("A valid file name is required.");
  const format = /\.([^.]+)$/.exec(fileName.trim())?.[1].toLowerCase();
  if (!["csv", "xlsx"].includes(format))
    fail("Only CSV and XLSX uploads are supported.");
  if ((content !== undefined) === (contentBase64 !== undefined))
    fail("Provide exactly one content source.");
  let originalBytes;
  if (contentBase64 !== undefined) {
    if (
      typeof contentBase64 !== "string" ||
      !contentBase64 ||
      contentBase64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      contentBase64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(contentBase64)
    ) {
      fail("Upload base64 must be canonical and within the 25 MiB limit.");
    }
    if (
      format === "xlsx" &&
      contentBase64.length > Math.ceil(MAX_XLSX_BYTES / 3) * 4
    )
      fail("XLSX exceeds the 2 MiB original file limit for this runtime.");
    originalBytes = Buffer.from(contentBase64, "base64");
    if (originalBytes.toString("base64") !== contentBase64)
      fail("Upload base64 is not canonical.");
  } else if (Buffer.isBuffer(content)) {
    if (content.byteLength > MAX_BYTES)
      fail("Uploaded file exceeds the 25 MiB limit.");
    if (format === "xlsx" && content.byteLength > MAX_XLSX_BYTES)
      fail("XLSX exceeds the 2 MiB original file limit for this runtime.");
    originalBytes = Buffer.from(content);
  } else if (format === "csv" && typeof content === "string") {
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES)
      fail("Uploaded file exceeds the 25 MiB limit.");
    originalBytes = Buffer.from(content, "utf8");
    if (originalBytes.toString("utf8") !== content)
      fail("CSV must contain valid UTF-8 text.");
  } else {
    fail(
      format === "xlsx"
        ? "XLSX content must be a binary Buffer or base64."
        : "CSV content must be UTF-8 text, a Buffer or base64.",
    );
  }
  if (!originalBytes.length) fail("File content is required.");
  if (originalBytes.length > MAX_BYTES)
    fail("Uploaded file exceeds the 25 MiB limit.");
  if (format === "xlsx") {
    if (originalBytes.length > MAX_XLSX_BYTES)
      fail("XLSX exceeds the 2 MiB original file limit for this runtime.");
    if (
      sheet !== undefined &&
      !(typeof sheet === "string" && sheet.length > 0 && sheet.length <= 255) &&
      !(Number.isSafeInteger(sheet) && sheet > 0)
    )
      fail("Select a valid sheet name or one-based sheet number.");
    return {
      ...(await parseWorkbook(originalBytes, sheet)),
      originalBytes,
      originalContentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      format,
    };
  }
  if (sheet !== undefined) fail("Sheet selection is only supported for XLSX.");
  let normalizedContent;
  try {
    // ignoreBOM retains a real BOM in the evidence string; csv-parse handles it.
    normalizedContent = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(originalBytes);
  } catch {
    fail("CSV must contain valid UTF-8 text.");
  }
  if (!normalizedContent.trim() || normalizedContent.includes("\0"))
    fail("CSV content must contain text without NUL characters.");
  return {
    originalBytes,
    originalContentType: "text/csv",
    normalizedContent,
    ...inspectCsv(normalizedContent),
    format,
    parserVersion: PARSER_VERSION,
    rowConvention: {
      headerRow: 1,
      firstDataRow: 2,
      unit: "nonempty-csv-record",
    },
  };
}

function inspectCsv(content) {
  let records,
    recordBytes = 0,
    cells = 0;
  try {
    records = parse(content, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
      max_record_size: MAX_RECORD_BYTES,
      to: 50_002,
      cast(value, { index }) {
        if (index >= 200) fail("The upload exceeds the limit of 200 columns.");
        recordBytes += Buffer.byteLength(value, "utf8");
        if (recordBytes > MAX_RECORD_BYTES)
          fail("An upload record exceeds the 1 MiB data limit.");
        return value;
      },
      on_record(record, { records: count }) {
        if (count > 50_001)
          fail("The upload exceeds the limit of 50,000 data rows.");
        if (count > 1 && (cells += record.length) > 1_000_000)
          fail("The upload exceeds the limit of 1,000,000 data cells.");
        recordBytes = 0;
        return record;
      },
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    fail(
      error?.code === "CSV_MAX_RECORD_SIZE"
        ? "An upload record exceeds the 1 MiB data limit."
        : "The CSV file could not be parsed.",
    );
  }
  if (records.length < 2)
    fail("The upload must contain a header and at least one data row.");
  const headers = records[0].map((value) => value.trim());
  if (headers.some((name) => !name))
    fail("The upload contains an empty column name.");
  validateCsvHeaderSizes(headers);
  if (
    new Set(headers.map((name) => name.toLowerCase())).size !== headers.length
  )
    fail("The upload contains duplicate column names.");
  return {
    rowCount: records.length - 1,
    previewRows: records.slice(1, 6),
    previewRowNumbers: records.slice(1, 6).map((_, i) => i + 2),
    columns: headers.map((name, index) => {
      let required = true;
      const types = new Set();
      for (let row = 1; row < records.length; row++) {
        const value = records[row][index].trim();
        if (!value) {
          required = false;
          continue;
        }
        types.add(inferTextType(value));
      }
      const type = types.size === 1 ? [...types][0] : "text";
      return { name, type, required, dataType: type, nullable: !required };
    }),
  };
}

function inferTextType(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
      return "date";
  }
  if (/^(?:true|false|yes|no)$/i.test(value)) return "boolean";
  // Classification never parses a decimal as Number, or strips arbitrary commas.
  // Leading-zero identifiers remain text even when every row looks numeric.
  if (
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
    /^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(value)
  )
    return "decimal";
  return "text";
}

function parseWorkbook(bytes, sheet) {
  if (activeXlsx)
    return Promise.reject(
      new AuthError(
        "An XLSX upload is already being normalized. Retry shortly.",
        "UPLOAD_BUSY",
      ),
    );
  activeXlsx = true;
  return new Promise((resolve, reject) => {
    let child, result, failure, timer;
    try {
      // A separate process keeps parser OOM outside the request process. Byte
      // budgets bound external buffers; these flags limit V8 heap, not OS RSS.
      child = fork(new URL("./xlsx-parser-worker.mjs", import.meta.url), [], {
        execArgv: [
          "--max-old-space-size=24",
          "--max-semi-space-size=1",
          "--disable-proto=throw",
        ],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        // Do not forward application secrets, NODE_OPTIONS, preloads or loaders.
        env: Object.fromEntries(
          ["SystemRoot", "SYSTEMROOT", "PATH", "NODE_PATH"]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
      });
      timer = setTimeout(() => {
        failure = new AuthError(
          "XLSX processing exceeded the 15 second limit. Export a smaller values-only workbook or CSV.",
          "UPLOAD_RESOURCE_LIMIT",
        );
        child.kill("SIGKILL");
      }, 15_000);
      child.on("message", (message) => {
        if (message?.ok === true) result = message.result;
        else {
          failure = new AuthError(
            message?.message ?? "The XLSX file could not be parsed.",
            message?.code ?? "VALIDATION_FAILED",
          );
          if (Array.isArray(message?.sheets)) failure.sheets = message.sheets;
        }
      });
      child.on("error", () => {
        failure = new AuthError(
          "The XLSX parser could not start.",
          "UPLOAD_PARSER_UNAVAILABLE",
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        activeXlsx = false;
        if (failure) reject(failure);
        else if (code !== 0 || !result)
          reject(
            new AuthError(
              "XLSX processing stopped at its resource boundary. Export a smaller values-only workbook or CSV.",
              "UPLOAD_RESOURCE_LIMIT",
            ),
          );
        else resolve(result);
      });
      child.send({ bytes, sheet }, (error) => {
        if (error) {
          failure = new AuthError(
            "The XLSX parser could not receive the upload.",
            "UPLOAD_PARSER_UNAVAILABLE",
          );
          child.kill("SIGKILL");
        }
      });
    } catch {
      clearTimeout(timer);
      activeXlsx = false;
      if (child) child.kill("SIGKILL");
      reject(
        new AuthError(
          "The XLSX parser could not start.",
          "UPLOAD_PARSER_UNAVAILABLE",
        ),
      );
    }
  });
}

function fail(message) {
  throw new AuthError(message, "VALIDATION_FAILED");
}
