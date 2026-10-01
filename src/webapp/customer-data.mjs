import { randomUUID, createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import { AuthError } from "../auth/core.mjs";
import { buildReportCube, isAdditiveReportColumn } from "../reports/evidence-engine.mjs";

const DECIMAL_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LIKE_PATTERN =
  /^(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})$/;
const MONEY_COLUMN_PATTERN =
  /(revenue|sales|amount|price|total|cost|payment|transaction|value|gross|net|fee|margin)/i;
const IDENTIFIER_COLUMN_PATTERN =
  /(^id$|_id$|id$|number$|no$|code$|sku$|reference|phone|zip|postal)/i;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 50000;
const MAX_UPLOAD_COLUMNS = 200;
const MAX_COLUMN_NAME_LENGTH = 80;
const MAX_FREE_TEXT_LINE_LENGTH = 320;
const ACCEPTED_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".json",
  ".txt",
  ".pdf",
  ".xlsx",
  ".xls",
]);
const TEXT_EXTENSIONS = new Set([".csv", ".tsv", ".json", ".txt"]);

export function validateCustomerUpload(body, organizationId) {
  return validatePreparedUpload({
    body,
    organizationId,
    source: prepareUploadSourceSync(body),
  });
}

export async function validateCustomerUploadFile(body, organizationId) {
  return validatePreparedUpload({
    body,
    organizationId,
    source: await prepareUploadSource(body),
  });
}

function validatePreparedUpload({ body, organizationId, source }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period ?? ""))
    throw new AuthError("Choose a reporting month.", "VALIDATION_FAILED");
  if (!source.rows.length && !source.issues.length)
    throw new AuthError(
      "Upload between 1 and 50,000 rows.",
      "VALIDATION_FAILED",
    );
  if (source.rows.length > MAX_UPLOAD_ROWS)
    throw new AuthError(
      "Upload between 1 and 50,000 rows.",
      "VALIDATION_FAILED",
    );

  const rows = source.rows;
  const columns = source.columns;
  const issues = [...source.issues];
  const profile = rows.length
    ? profileDataset(rows, columns)
    : { numericProfile: [], dimensionProfile: [], dateProfile: [] };
  const requestedMetric = clean(body.metricColumn || body.revenueColumn);
  const metricColumn = chooseMetricColumn({
    columns,
    numericProfile: profile.numericProfile,
    requestedMetric,
  });
  if (requestedMetric && !findColumn(columns, requestedMetric)) {
    issues.push({
      row: null,
      message: `Metric column "${requestedMetric}" was not found. Choose the matching column and upload again.`,
    });
  }
  if (!metricColumn) {
    issues.push({
      row: null,
      message:
        "No numeric metric column was found. Choose a column such as revenue, amount, quantity, cost or total.",
    });
  }

  const metricValidation = metricColumn
    ? validateMetricRows(rows, metricColumn)
    : { cents: 0n, invalidRows: [] };
  for (const issue of metricValidation.invalidRows.slice(0, 50)) {
    issues.push(issue);
  }
  if (metricValidation.invalidRows.length > 50) {
    issues.push({
      row: null,
      message: `${metricValidation.invalidRows.length - 50} additional metric rows were invalid.`,
    });
  }
  if (
    metricValidation.cents > BigInt(Number.MAX_SAFE_INTEGER) ||
    metricValidation.cents < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    issues.push({
      row: null,
      message: "The metric total exceeds the supported amount range.",
    });

  const metricType = isMoneyColumn(metricColumn) ? "money" : "number";
  const metricAverageCents =
    rows.length === 0
      ? 0n
      : divideRounded(metricValidation.cents, BigInt(rows.length));
  const dataSeries = clean(body.dataSeries) || "Primary performance";
  const dataKind = clean(body.dataKind) || inferDataKind(columns);
  return {
    id: randomUUID(),
    organizationId,
    fileName: source.fileName,
    fileExtension: source.extension,
    sourceFormat: source.sourceFormat,
    sourceSizeBytes: source.sourceSizeBytes,
    period: body.period,
    dataKind,
    dataSeries,
    seriesKey: stableSeriesKey(dataSeries),
    metricColumn,
    metricLabel: metricColumn ? labelForColumn(metricColumn) : "Metric",
    metricType,
    metricCents: metricValidation.cents.toString(),
    metricValue: centsToDecimal(metricValidation.cents),
    metricAverage: centsToDecimal(metricAverageCents),
    revenueColumn: metricColumn,
    revenueCents: metricValidation.cents.toString(),
    columns,
    rowCount: rows.length,
    preview: rows.slice(0, 5),
    numericProfile: profile.numericProfile,
    dimensionProfile: profile.dimensionProfile,
    dimensionBreakdowns: metricColumn
      ? buildMetricDimensionBreakdowns(rows, columns, metricColumn).slice(0, 6)
      : [],
    dateProfile: profile.dateProfile,
    reportCube: buildReportCube({ rows, columns }),
    issues,
    status: issues.length ? "rejected" : "awaiting_confirmation",
    checksum: source.checksum,
    content: source.retainedContent,
    createdAt: new Date(),
    confirmedAt: null,
  };
}

function prepareUploadSourceSync(body) {
  const source = baseUploadSource(body);
  if (source.extension === ".pdf") {
    return {
      ...source,
      rows: [],
      columns: [],
      issues: [
        {
          row: null,
          message:
            "PDF files are accepted, but this upload path needs the server PDF extractor. Upload through the browser workspace to extract statement text.",
        },
      ],
      retainedContent: "",
      sourceFormat: "PDF document",
    };
  }
  if ([".xlsx", ".xls"].includes(source.extension)) {
    return unsupportedSpreadsheetSource(source);
  }
  return extractRowsFromSource(source);
}

async function prepareUploadSource(body) {
  const source = baseUploadSource(body);
  if (source.extension === ".pdf") {
    return extractPdfSource(source);
  }
  if ([".xlsx", ".xls"].includes(source.extension)) {
    return unsupportedSpreadsheetSource(source);
  }
  return extractRowsFromSource(source);
}

function baseUploadSource(body) {
  if (
    typeof body.fileName !== "string" ||
    !body.fileName.trim() ||
    body.fileName.length > 180
  ) {
    throw new AuthError("File name is required.", "VALIDATION_FAILED");
  }
  const fileName = body.fileName.trim();
  const extension = fileExtension(fileName);
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    throw new AuthError(
      "Choose a supported business file: CSV, TSV, JSON, TXT, PDF or XLSX.",
      "VALIDATION_FAILED",
    );
  }
  const buffer =
    typeof body.contentBase64 === "string"
      ? Buffer.from(body.contentBase64, "base64")
      : Buffer.from(String(body.content ?? ""), "utf8");
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) {
    throw new AuthError(
      "Choose a supported file smaller than 25 MB.",
      "VALIDATION_FAILED",
    );
  }
  return {
    fileName,
    extension,
    buffer,
    sourceSizeBytes: Number(body.sizeBytes) || buffer.length,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    text:
      typeof body.content === "string" && TEXT_EXTENSIONS.has(extension)
        ? body.content
        : buffer.toString("utf8"),
  };
}

function extractRowsFromSource(source) {
  if (source.extension === ".json") {
    const { rows, columns } = parseJsonRows(source.text);
    return {
      ...source,
      rows,
      columns,
      issues: [],
      retainedContent: source.text,
      sourceFormat: "JSON records",
    };
  }
  if (source.extension === ".txt") {
    const extracted = extractRowsFromFreeText(source.text);
    return {
      ...source,
      ...extracted,
      issues: extracted.rows.length
        ? []
        : [
            {
              row: null,
              message:
                "The text file was accepted, but no transaction-like rows were detected. Use CSV/TSV/JSON or include lines with date, description and amount.",
            },
          ],
      retainedContent: source.text,
      sourceFormat: "Text statement",
    };
  }
  const delimiter = source.extension === ".tsv" ? "\t" : ",";
  const { rows, columns } = parseDelimitedRows(source.text, delimiter);
  return {
    ...source,
    rows,
    columns,
    issues: [],
    retainedContent: source.text,
    sourceFormat: source.extension === ".tsv" ? "TSV table" : "CSV table",
  };
}

async function extractPdfSource(source) {
  let parser;
  try {
    parser = new PDFParse({ data: source.buffer });
    const result = await parser.getText({ partial: [1, 2, 3, 4, 5] });
    const extracted = extractRowsFromFreeText(result.text ?? "");
    return {
      ...source,
      ...extracted,
      issues: extracted.rows.length
        ? []
        : [
            {
              row: null,
              message:
                "The PDF was accepted, but no usable transaction table was detected. Upload a text-based statement with date, description and amount rows, or export the data as CSV/TSV/JSON.",
            },
          ],
      retainedContent: result.text ?? "",
      sourceFormat: "PDF text extraction",
    };
  } catch {
    return {
      ...source,
      rows: [],
      columns: [],
      issues: [
        {
          row: null,
          message:
            "The PDF could not be read safely. Password-protected, scanned-image or malformed PDFs need OCR or a bank/export connector before they can become evidence.",
        },
      ],
      retainedContent: "",
      sourceFormat: "PDF document",
    };
  } finally {
    await parser?.destroy();
  }
}

function unsupportedSpreadsheetSource(source) {
  return {
    ...source,
    rows: [],
    columns: [],
    issues: [
      {
        row: null,
        message:
          "Excel files are accepted into the intake queue, but spreadsheet extraction is not enabled in this build because the available parser failed the production security audit. Export this workbook as CSV for evidence analysis.",
      },
    ],
    retainedContent: "",
    sourceFormat: "Excel workbook",
  };
}

function parseDelimitedRows(content, delimiter) {
  let rows;
  let columns;
  try {
    rows = parse(content, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 16384,
      columns: (headers) => {
        columns = headers;
        if (new Set(headers).size !== headers.length || headers.some((h) => !h))
          throw new Error("Duplicate or empty columns.");
        return headers;
      },
    });
  } catch {
    throw new AuthError(
      "The table could not be read. Check column names, quotes and row lengths.",
      "VALIDATION_FAILED",
    );
  }
  if (!rows.length || rows.length > MAX_UPLOAD_ROWS)
    throw new AuthError(
      "Upload between 1 and 50,000 rows.",
      "VALIDATION_FAILED",
    );
  return { rows: rows.map(normalizeRow), columns };
}

function parseJsonRows(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AuthError(
      "The JSON file could not be read. Upload an array of business records.",
      "VALIDATION_FAILED",
    );
  }
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : Array.isArray(parsed?.data)
        ? parsed.data
        : Array.isArray(parsed?.transactions)
          ? parsed.transactions
          : null;
  if (!records)
    throw new AuthError(
      "The JSON file must contain an array of records, or a rows/data/transactions array.",
      "VALIDATION_FAILED",
    );
  if (!records.length || records.length > MAX_UPLOAD_ROWS)
    throw new AuthError(
      "Upload between 1 and 50,000 rows.",
      "VALIDATION_FAILED",
    );
  const columns = [];
  const rows = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new AuthError(
        "Each JSON record must be an object with named fields.",
        "VALIDATION_FAILED",
      );
    const row = {};
    for (const [key, value] of Object.entries(record)) {
      if (key.length > MAX_COLUMN_NAME_LENGTH) {
        throw new AuthError(
          "A JSON column name exceeds the supported size.",
          "VALIDATION_FAILED",
        );
      }
      if (columns.length >= MAX_UPLOAD_COLUMNS && !columns.includes(key)) {
        throw new AuthError(
          "Upload exceeds the supported limit of 200 columns.",
          "VALIDATION_FAILED",
        );
      }
      if (!columns.includes(key)) columns.push(key);
      row[key] = value === null || value === undefined ? "" : String(value);
    }
    return row;
  });
  if (!columns.length)
    throw new AuthError(
      "The JSON records did not contain any columns.",
      "VALIDATION_FAILED",
    );
  return { rows: rows.map(normalizeRow), columns };
}

function extractRowsFromFreeText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length <= MAX_FREE_TEXT_LINE_LENGTH);
  const delimited = parseDelimitedTextLines(lines);
  if (delimited.rows.length) return delimited;
  const rows = [];
  const pattern =
    /^(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})\s+(.+?)\s+(\(?-?[$€£₦]?\d[\d,]*(?:\.\d{1,2})?\)?)$/;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    rows.push({
      date: normalizeDate(match[1]),
      description: match[2].replace(/\s+/g, " ").trim().slice(0, 200),
      amount: normalizeDecimalText(match[3]),
    });
  }
  return { rows, columns: rows.length ? ["date", "description", "amount"] : [] };
}

function parseDelimitedTextLines(lines) {
  const sample = lines.slice(0, 10).join("\n");
  for (const delimiter of [",", "\t", "|"]) {
    if (!sample.includes(delimiter)) continue;
    try {
      const parsed = parseDelimitedRows(lines.join("\n"), delimiter);
      if (parsed.columns.length > 1) return parsed;
    } catch {
      // Try the next delimiter before treating free text as a statement.
    }
  }
  return { rows: [], columns: [] };
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, String(value ?? "").trim()]),
  );
}

export function publicUpload(upload) {
  const { content, organizationId, reportCube, ...publicFields } = upload;
  return publicFields;
}

export function reportSourcesFromUploads(uploads) {
  return uploads.filter((upload) => upload.status === "confirmed").map((upload) => {
    if (!upload.reportCube && upload.content) {
      const source = upload.fileExtension === ".pdf"
        ? extractRowsFromFreeText(upload.content)
        : prepareUploadSourceSync({ fileName: upload.fileName, content: upload.content });
      upload.reportCube = buildReportCube(source);
    }
    return { id: upload.id, seriesKey: upload.seriesKey, dataSeries: upload.dataSeries,
      period: upload.period, fileName: upload.fileName, checksum: upload.checksum,
      confirmedAt: upload.confirmedAt, cube: upload.reportCube };
  });
}

export function buildEvidenceReports(uploads, profile = null) {
  const confirmed = uploads
    .filter((upload) => upload.status === "confirmed")
    .sort((a, b) =>
      `${a.seriesKey}:${a.period}`.localeCompare(`${b.seriesKey}:${b.period}`),
    );
  const previousBySeries = new Map();
  return confirmed.map((upload) => {
    const previous = previousBySeries.get(upload.seriesKey) ?? null;
    previousBySeries.set(upload.seriesKey, upload);
    return buildEvidenceReport({ upload, previous, profile });
  });
}

export function buildEvidenceReport({ upload, previous = null, profile = null }) {
  const metricStat = upload.numericProfile.find(
    (column) => column.name === upload.metricColumn,
  );
  const metricChange = previous
    ? compareCents(upload.metricCents, previous.metricCents)
    : null;
  const strongestColumns = previous
    ? strongestNumericChanges(upload, previous).slice(0, 3)
    : [];
  const driverFacts = buildDriverFacts({ upload, previous });
  const focusAreas = buildDecisionNotes({
    upload,
    previous,
    metricChange,
    driverFacts,
  });
  const evidenceQuality = assessEvidenceQuality({
    upload,
    previous,
  });
  const limitations = buildDataLimitations({
    upload,
    previous,
    driverFacts,
  });
  const analystBrief = buildAnalystBrief({
    upload,
    previous,
    metricChange,
    driverFacts,
    focusAreas,
    evidenceQuality,
    limitations,
  });
  const verifiedFacts = [
    {
      label: "Source rows checked",
      value: String(upload.rowCount),
      evidence: `${upload.fileName} contains ${upload.rowCount} accepted data row(s).`,
    },
    {
      label: `${upload.metricLabel} total`,
      value: formatReportMetric(upload, upload.metricCents),
      evidence: `Calculated with sum(${upload.metricColumn}) across ${upload.rowCount} row(s).`,
    },
    {
      label: "Columns profiled",
      value: String(upload.columns.length),
      evidence: upload.columns.join(", "),
    },
    {
      label: "Source format",
      value: upload.sourceFormat ?? "Business file",
      evidence: `${upload.fileName} was processed as ${upload.sourceFormat ?? "a business file"}.`,
    },
  ];
  if (metricStat) {
    verifiedFacts.push({
      label: `${upload.metricLabel} average`,
      value: formatReportMetric(upload, metricStat.averageCents),
      evidence: `Average of ${metricStat.validCount} numeric row value(s).`,
    });
  }

  const trendSignals = [];
  if (!previous) {
    trendSignals.push({
      label: "Baseline created",
      value: "First confirmed period in this data series",
      evidence: `${upload.period} starts the ${upload.dataSeries} history.`,
      classification: "VERIFIED FACT",
    });
  } else {
    trendSignals.push({
      label: `${upload.metricLabel} movement`,
      value:
        metricChange.percentChange === null
          ? `${formatReportMetric(upload, metricChange.absoluteChangeCents)} change`
          : `${signedPercent(metricChange.percentChange)} vs ${previous.period}`,
      evidence: `${formatReportMetric(previous, previous.metricCents)} in ${previous.period} to ${formatReportMetric(upload, upload.metricCents)} in ${upload.period}.`,
      classification: "VERIFIED FACT",
    });
  }
  for (const change of strongestColumns) {
    trendSignals.push({
      label: `${labelForColumn(change.name)} changed`,
      value:
        change.percentChange === null
          ? `${centsToDecimal(change.absoluteChangeCents)} absolute change`
        : `${signedPercent(change.percentChange)} vs ${previous.period}`,
      evidence: `${change.name}: ${centsToDecimal(change.previousCents)} to ${centsToDecimal(change.currentCents)}.`,
      classification: "VERIFIED FACT",
    });
  }

  return {
    id: `evidence_${upload.id}`,
    uploadId: upload.id,
    title: `${upload.dataSeries} evidence report`,
    period: upload.period,
    dataKind: upload.dataKind,
    dataSeries: upload.dataSeries,
    metricLabel: upload.metricLabel,
    generatedAt: upload.confirmedAt ?? upload.createdAt,
    profileName: profile?.legalName ?? profile?.tradingName ?? null,
    summary: reportSummary({ upload, previous, metricChange }),
    analystBrief,
    evidenceQuality,
    limitations,
    recommendedFocus: buildRecommendedFocus({
      upload,
      previous,
      metricChange,
      driverFacts,
      focusAreas,
      evidenceQuality,
      limitations,
    }),
    verifiedFacts,
    trendSignals,
    driverFacts,
    focusAreas,
    sourceEvidence: {
      fileName: upload.fileName,
      sourceFormat: upload.sourceFormat,
      fileExtension: upload.fileExtension,
      checksum: upload.checksum,
      rowCount: upload.rowCount,
      columns: upload.columns,
      metricColumn: upload.metricColumn,
      dimensionBreakdowns: upload.dimensionBreakdowns ?? [],
      previousUploadId: previous?.id ?? null,
      calculation: `sum(${upload.metricColumn})`,
    },
  };
}

function buildAnalystBrief({
  upload,
  previous,
  metricChange,
  driverFacts,
  focusAreas,
  evidenceQuality,
  limitations,
}) {
  const metricName = upload.metricLabel;
  const periodText = previous
    ? `${previous.period} to ${upload.period}`
    : upload.period;
  const topDriver = driverFacts[0] ?? null;
  const primaryFocus = focusAreas[0] ?? null;
  const qualityLabel = evidenceQuality.label.toLowerCase();

  if (!previous) {
    return {
      headline: `${upload.dataSeries} now has a verified baseline.`,
      opening: `${upload.period} is the first confirmed period for this series, so the report explains what is known and what still needs more history.`,
      interpretation: `BIZNORYX verified ${upload.rowCount} source row(s) and established ${metricName} as the first measurable point for ${upload.dataSeries}. This is useful as a starting record, but it should not be treated as a trend yet.`,
      whatHappened: `${upload.fileName} was validated and confirmed for ${upload.period}. The report can describe the current period, but comparison requires another verified period.`,
      whereToLook: topDriver
        ? `${topDriver.label} is the clearest place to inspect first because it is the largest contributor available in this dataset.`
        : "Driver analysis is limited because the upload does not include a reusable business dimension such as product, channel, location, category or segment.",
      nextMove: "Upload the next comparable period using the same data series and column structure. That will let BIZNORYX separate normal activity from real movement.",
      watchNext: [
        `Whether ${metricName} rises, falls or stays stable in the next confirmed period.`,
        "Whether the same top contributor remains important when another period is available.",
        ...limitations.map((item) => item.message).slice(0, 1),
      ],
      caution: `${evidenceQuality.label}: ${evidenceQuality.reason}`,
    };
  }

  const movementText =
    metricChange.percentChange === null
      ? `${formatReportMetric(upload, metricChange.absoluteChangeCents)} from ${previous.period}`
      : `${signedPercent(metricChange.percentChange)} from ${previous.period}`;
  const direction =
    metricChange.absoluteChangeCents > 0n
      ? "increased"
      : metricChange.absoluteChangeCents < 0n
        ? "declined"
        : "stayed level";

  return {
    headline: `${metricName} ${direction} in the latest verified period.`,
    opening: `${metricName} ${direction} across ${periodText}. The report shows the movement, the most useful contributor evidence, and the areas worth reviewing first.`,
    interpretation: `${metricName} moved ${movementText}. This is a verified movement, not a causal explanation. Use the driver evidence to decide which area deserves management attention before taking action.`,
    whatHappened: `${metricName} moved from ${formatReportMetric(previous, previous.metricCents)} in ${previous.period} to ${formatReportMetric(upload, upload.metricCents)} in ${upload.period}.`,
    whereToLook: topDriver
      ? `${topDriver.label} is the first place to review because it has the clearest contribution evidence in this report: ${topDriver.value}.`
      : "No reusable contributor column was available, so the first review should stay at the overall metric and source-data level.",
    nextMove: primaryFocus
      ? `${primaryFocus.value}. Treat this as an investigation step, then turn the finding into one focused action if the business owner agrees.`
      : "Choose one management question for this metric, then compare the next period before changing strategy.",
    watchNext: [
      `Whether the ${metricName} movement persists in the next period.`,
      topDriver
        ? `Whether ${topDriver.label} remains the largest contributor.`
        : "Whether future uploads include product, channel, location or category fields for better driver analysis.",
      `${qualityLabel} evidence means the report should be used with the stated limitations in mind.`,
    ],
    caution:
      "Contribution is not causation. This report explains verified movement and where to investigate; it does not prove why the movement happened.",
  };
}

function assessEvidenceQuality({ upload, previous }) {
  const hasComparison = Boolean(previous);
  const hasRows = upload.rowCount > 0;
  const hasDrivers = (upload.dimensionBreakdowns ?? []).length > 0;
  const hasStableSchema = previous
    ? sameColumns(upload.columns, previous.columns)
    : true;

  if (!hasRows) {
    return {
      level: "insufficient_evidence",
      label: "INSUFFICIENT EVIDENCE",
      reason: "No accepted source rows were available for this report.",
    };
  }

  if (hasComparison && hasDrivers && hasStableSchema && upload.rowCount >= 2) {
    return {
      level: "high_evidence",
      label: "HIGH EVIDENCE",
      reason:
        "The report uses confirmed source rows, a comparable previous period, stable columns and reusable contributor fields.",
    };
  }

  if (hasComparison && hasStableSchema) {
    return {
      level: "moderate_evidence",
      label: "MODERATE EVIDENCE",
      reason:
        "The report has a verified comparison period, but contributor detail is limited.",
    };
  }

  return {
    level: "limited_evidence",
    label: "LIMITED EVIDENCE",
    reason:
      "The report has a verified source file, but more comparable history is required before trend conclusions are reliable.",
  };
}

function buildDataLimitations({ upload, previous, driverFacts }) {
  const limitations = [];

  if (!previous) {
    limitations.push({
      type: "comparison",
      message:
        "No previous verified period exists yet, so this report cannot classify a trend.",
    });
  }

  if ((driverFacts ?? []).length === 0) {
    limitations.push({
      type: "drivers",
      message:
        "Driver analysis is limited because no reusable contributor dimension was available.",
    });
  }

  if (previous && !sameColumns(upload.columns, previous.columns)) {
    limitations.push({
      type: "schema",
      message:
        "The current and previous files do not have the same column structure, so comparisons should be reviewed carefully.",
    });
  }

  return limitations;
}

function buildRecommendedFocus({
  previous,
  metricChange,
  driverFacts,
  focusAreas,
  evidenceQuality,
  limitations,
}) {
  if (evidenceQuality.level === "insufficient_evidence") {
    return {
      focusNow: [],
      protect: [],
      monitor: [],
      notEnoughEvidence: limitations.map((item) => item.message),
    };
  }

  const focusNow =
    previous &&
    metricChange.absoluteChangeCents < 0n
      ? focusAreas.map((item) => item.value).slice(0, 2)
      : [];

  const protect =
    previous &&
    metricChange.absoluteChangeCents > 0n
      ? focusAreas.map((item) => item.value).slice(0, 2)
      : [];

  return {
    focusNow,
    protect,
    monitor: driverFacts.map((item) => item.label).slice(0, 2),
    notEnoughEvidence: limitations.map((item) => item.message),
  };
}

function buildDecisionNotes({ upload, previous, metricChange }) {
  const notes = [];
  if (!previous) {
    notes.push({
      label: "Baseline next step",
      value: "Confirm the next comparable period",
      evidence: `${upload.period} is the first confirmed period for ${upload.dataSeries}. A second period is required before movement can be classified.`,
      classification: "RECOMMENDATION",
    });
  } else if (
    metricChange.percentChange !== null
      ? metricChange.percentChange > 0
      : metricChange.absoluteChangeCents > 0n
  ) {
    notes.push({
      label: "Advantage",
      value: `${upload.metricLabel} increased`,
      evidence: `${upload.metricLabel} rose from ${formatReportMetric(previous, previous.metricCents)} in ${previous.period} to ${formatReportMetric(upload, upload.metricCents)} in ${upload.period}.`,
      classification: "INFERENCE",
    });
  } else if (metricChange.absoluteChangeCents < 0n) {
    notes.push({
      label: "Disadvantage",
      value: `${upload.metricLabel} declined`,
      evidence: `${upload.metricLabel} moved from ${formatReportMetric(previous, previous.metricCents)} in ${previous.period} to ${formatReportMetric(upload, upload.metricCents)} in ${upload.period}.`,
      classification: "INFERENCE",
    });
  } else {
    notes.push({
      label: "Stable period",
      value: `${upload.metricLabel} did not materially move`,
      evidence: `${upload.period} matched the previous confirmed period within this data series.`,
      classification: "VERIFIED FACT",
    });
  }

  const topBreakdown = upload.dimensionBreakdowns?.[0];
  const topValue = topBreakdown?.topValues?.[0];
  if (topBreakdown && topValue) {
    const share = topValue.shareOfMetric;
    if (share !== null && share >= 50) {
      notes.push({
        label: "Concentration risk",
        value: `${topValue.value} drives ${share.toFixed(1)}% of ${upload.metricLabel}`,
        evidence: `${topValue.value} contributes ${formatReportMetric(upload, topValue.sumCents)} across ${topValue.count} row(s) in ${topBreakdown.label}.`,
        classification: "STATISTICAL SIGNAL",
      });
    }
    notes.push({
      label: "Focus area",
      value: `Review ${topBreakdown.label}: ${topValue.value}`,
      evidence: `${topValue.value} is the largest measured contributor in ${upload.period}. This is a recommended place to inspect pricing, stock, marketing, service capacity or spend decisions.`,
      classification: "RECOMMENDATION",
    });
  }
  return notes;
}

function profileDataset(rows, columns) {
  if (columns.length > MAX_UPLOAD_COLUMNS) {
    throw new AuthError(
      "Upload exceeds the supported limit of 200 columns.",
      "VALIDATION_FAILED",
    );
  }

  const numericProfile = [];
  const dimensionProfile = [];
  const dateProfile = [];
  for (const column of columns) {
    let sumCents = 0n;
    let minCents = null;
    let maxCents = null;
    let validNumberCount = 0;
    let invalidNumberCount = 0;
    let validDateCount = 0;
    let minDate = null;
    let maxDate = null;
    const top = new Map();
    for (const row of rows) {
      const value = clean(row[column]);
      if (!value) continue;
      top.set(value, (top.get(value) ?? 0) + 1);
      const decimalValue = normalizeDecimalText(value);
      if (decimalValue && DECIMAL_PATTERN.test(decimalValue)) {
        const cents = decimalToCents(decimalValue);
        sumCents += cents;
        minCents = minCents === null || cents < minCents ? cents : minCents;
        maxCents = maxCents === null || cents > maxCents ? cents : maxCents;
        validNumberCount += 1;
      } else {
        invalidNumberCount += 1;
      }
      const dateValue = normalizeDate(value);
      if (dateValue) {
        validDateCount += 1;
        minDate = minDate === null || dateValue < minDate ? dateValue : minDate;
        maxDate = maxDate === null || dateValue > maxDate ? dateValue : maxDate;
      }
    }
    if (validNumberCount > 0 && invalidNumberCount === 0) {
      numericProfile.push({
        name: column,
        label: labelForColumn(column),
        valueType: isMoneyColumn(column) ? "money" : "number",
        validCount: validNumberCount,
        sumCents: sumCents.toString(),
        averageCents: divideRounded(
          sumCents,
          BigInt(validNumberCount),
        ).toString(),
        minCents: String(minCents ?? 0n),
        maxCents: String(maxCents ?? 0n),
      });
    }
    if (top.size > 0 && !IDENTIFIER_COLUMN_PATTERN.test(column)) {
      dimensionProfile.push({
        name: column,
        label: labelForColumn(column),
        uniqueCount: top.size,
        topValues: [...top.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([value, count]) => ({
            value,
            count,
            share: count / rows.length,
          })),
      });
    }
    if (validDateCount > 0) {
      dateProfile.push({
        name: column,
        label: labelForColumn(column),
        minDate,
        maxDate,
        validCount: validDateCount,
      });
    }
  }
  return { numericProfile, dimensionProfile, dateProfile };
}

function chooseMetricColumn({ columns, numericProfile, requestedMetric }) {
  if (requestedMetric) return findColumn(columns, requestedMetric);
  const preferred = [
    "revenue",
    "sales",
    "amount",
    "total",
    "transaction_amount",
    "payment",
    "quantity",
    "units",
    "cost",
    "profit",
    "margin",
    "tickets",
  ];
  for (const candidate of preferred) {
    const match = findColumn(columns, candidate);
    if (match) return match;
  }
  const numericCandidate = numericProfile.find(
    (column) => !IDENTIFIER_COLUMN_PATTERN.test(column.name),
  );
  return numericCandidate?.name ?? null;
}

function validateMetricRows(rows, metricColumn) {
  let cents = 0n;
  const invalidRows = [];
  rows.forEach((row, index) => {
    const value = normalizeDecimalText(row[metricColumn]);
    if (!value || !DECIMAL_PATTERN.test(value)) {
      invalidRows.push({
        row: index + 2,
        message:
          "The selected metric column must contain numeric values with at most two decimal places.",
      });
      return;
    }
    cents += decimalToCents(value);
  });
  return { cents, invalidRows };
}

function strongestNumericChanges(upload, previous) {
  const previousStats = new Map(
    previous.numericProfile.map((column) => [column.name, column]),
  );
  return upload.numericProfile
    .filter((column) => previousStats.has(column.name))
    .map((column) => {
      const previousColumn = previousStats.get(column.name);
      const currentCents = BigInt(column.sumCents);
      const previousCents = BigInt(previousColumn.sumCents);
      const compared = compareCents(currentCents, previousCents);
      return {
        name: column.name,
        currentCents,
        previousCents,
        ...compared,
      };
    })
    .sort(
      (a, b) =>
        Number(absBigInt(b.absoluteChangeCents)) -
          Number(absBigInt(a.absoluteChangeCents)) ||
        a.name.localeCompare(b.name),
    );
}

function buildMetricDimensionBreakdowns(rows, columns, metricColumn) {
  const metricTotal = rows.reduce((total, row) => {
    const value = normalizeDecimalText(row[metricColumn]);
    return value && DECIMAL_PATTERN.test(value)
      ? total + decimalToCents(value)
      : total;
  }, 0n);
  return columns
    .filter((column) => column !== metricColumn && !IDENTIFIER_COLUMN_PATTERN.test(column))
    .map((column) => {
      const values = new Map();
      for (const row of rows) {
        const dimensionValue = clean(row[column]) || "(blank)";
        const metricValue = normalizeDecimalText(row[metricColumn]);
        if (!metricValue || !DECIMAL_PATTERN.test(metricValue)) continue;
        const cents = decimalToCents(metricValue);
        const current = values.get(dimensionValue) ?? {
          value: dimensionValue,
          count: 0,
          sumCents: 0n
        };
        current.count += 1;
        current.sumCents += cents;
        values.set(dimensionValue, current);
      }
      return {
        name: column,
        label: labelForColumn(column),
        uniqueCount: values.size,
        topValues: [...values.values()]
          .sort((a, b) => compareBigInt(b.sumCents, a.sumCents) || b.count - a.count || a.value.localeCompare(b.value))
          .slice(0, 5)
          .map((item) => ({
            value: item.value,
            count: item.count,
            sumCents: item.sumCents.toString(),
            shareOfMetric:
              metricTotal === 0n
                ? null
                : Number((item.sumCents * 10000n) / metricTotal) / 100
          }))
      };
    })
    .filter((column) => column.uniqueCount > 1 && column.topValues.length > 0)
    .sort((a, b) => {
      const aTop = BigInt(a.topValues[0]?.sumCents ?? "0");
      const bTop = BigInt(b.topValues[0]?.sumCents ?? "0");
      return compareBigInt(bTop, aTop) || a.name.localeCompare(b.name);
    });
}

function buildDriverFacts({ upload, previous }) {
  const previousByColumn = new Map(
    (previous?.dimensionBreakdowns ?? []).map((column) => [column.name, column]),
  );
  return (upload.dimensionBreakdowns ?? []).slice(0, 4).flatMap((column) => {
    const topValue = column.topValues[0];
    if (!topValue) return [];
    const facts = [
      {
        label: `${column.label} contribution`,
        value: formatContribution(upload, topValue),
        evidence: `${topValue.value} accounts for ${topValue.count} row(s) and ${formatReportMetric(upload, topValue.sumCents)} of ${upload.metricLabel} in ${upload.period}.`,
        classification: "VERIFIED FACT"
      }
    ];
    const previousColumn = previousByColumn.get(column.name);
    const previousValue = previousColumn?.topValues.find(
      (item) => item.value === topValue.value,
    );
    if (previous && previousValue) {
      const compared = compareCents(topValue.sumCents, previousValue.sumCents);
      facts.push({
        label: `${column.label} contribution movement`,
        value:
          compared.percentChange === null
            ? `${formatReportMetric(upload, compared.absoluteChangeCents)} change`
            : `${signedPercent(compared.percentChange)} vs ${previous.period}`,
        evidence: `${topValue.value} moved from ${formatReportMetric(previous, previousValue.sumCents)} in ${previous.period} to ${formatReportMetric(upload, topValue.sumCents)} in ${upload.period}.`,
        classification: "VERIFIED FACT"
      });
    }
    return facts;
  });
}

function formatContribution(upload, value) {
  const amount = formatReportMetric(upload, value.sumCents);
  if (value.shareOfMetric === null) return amount;
  return `${amount} (${value.shareOfMetric.toFixed(1)}% of ${upload.metricLabel})`;
}

function compareCents(currentValue, previousValue) {
  const currentCents = BigInt(currentValue);
  const previousCents = BigInt(previousValue);
  const absoluteChangeCents = currentCents - previousCents;
  const percentChange =
    previousCents === 0n
      ? null
      : Number(absoluteChangeCents * 10000n) /
        Number(absBigInt(previousCents) * 100n);
  return { absoluteChangeCents, percentChange };
}

function reportSummary({ upload, previous, metricChange }) {
  if (!previous)
    return `${upload.period} establishes the baseline for ${upload.dataSeries} using ${upload.rowCount} source row(s).`;
  const movement =
    metricChange.percentChange === null
      ? `${formatReportMetric(upload, metricChange.absoluteChangeCents)}`
      : signedPercent(metricChange.percentChange);
  return `${upload.metricLabel} moved ${movement} from ${previous.period} to ${upload.period}, based on confirmed ${upload.dataSeries} uploads.`;
}

function decimalToCents(value) {
  const normalized = normalizeDecimalText(value);
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace("-", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

function centsToDecimal(value) {
  const cents = BigInt(value);
  const negative = cents < 0n;
  const absolute = absBigInt(cents);
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function formatReportMetric(upload, cents) {
  const decimal = centsToDecimal(cents);
  if (upload.metricType === "money")
    return `${upload.primaryCurrency ?? ""}${upload.primaryCurrency ? " " : ""}${decimal}`;
  return decimal;
}

function signedPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function divideRounded(value, divisor) {
  if (divisor === 0n) return 0n;
  const negative = value < 0n;
  const absolute = absBigInt(value);
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function compareBigInt(left, right) {
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

function findColumn(columns, name) {
  const normalized = name.toLowerCase();
  return columns.find((column) => column.toLowerCase() === normalized) ?? null;
}

function sameColumns(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((column, index) => column === right[index]);
}

function isMoneyColumn(name) {
  return MONEY_COLUMN_PATTERN.test(name ?? "");
}

function labelForColumn(name) {
  return clean(name)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferDataKind(columns) {
  const joined = columns.join(" ").toLowerCase();
  if (/transaction|payment|amount|order/.test(joined))
    return "Transaction history";
  if (/revenue|sales|customer|product|sku/.test(joined))
    return "Sales performance";
  if (/inventory|stock|quantity|warehouse/.test(joined))
    return "Inventory movement";
  if (/ticket|support|issue|status|resolution/.test(joined))
    return "Service operations";
  return "Business dataset";
}

function stableSeriesKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function isValidDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function fileExtension(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

function normalizeDecimalText(value) {
  let text = clean(value);
  if (!text) return "";
  let negative = false;
  if (/^\(.+\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[,$€£₦\s]/g, "");
  if (text.startsWith("+")) text = text.slice(1);
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (!DECIMAL_PATTERN.test(text)) return "";
  return negative ? `-${text}` : text;
}

function normalizeDate(value) {
  const text = clean(value);
  if (!DATE_LIKE_PATTERN.test(text)) return null;
  if (DATE_PATTERN.test(text)) return isValidDate(text) ? text : null;
  const [month, day, year] = text.split(/[/-]/);
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isValidDate(normalized) ? normalized : null;
}

function clean(value) {
  return String(value ?? "").trim();
}
