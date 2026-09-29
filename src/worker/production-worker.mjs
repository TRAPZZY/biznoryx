import {
  createHash,
} from "node:crypto";

import {
  parse,
} from "csv-parse/sync";
import { buildReportCube, isAdditiveReportColumn } from "../reports/evidence-engine.mjs";

const METRIC_DECIMAL_SCALE =
  10;

const METRIC_DECIMAL_FACTOR =
  10n ** BigInt(
    METRIC_DECIMAL_SCALE,
  );

export class ProductionWorker {
  constructor({
    repository,
    objectStorage,
    metricsRepository = null,
    comparisonRepository = null,
    findingsRepository = null,
    workerId,
    leaseSeconds = 60,
    pollIntervalMs = 1_000,
    heartbeatIntervalMs = 5_000,
    onError = () => {},
  }) {
    if (!repository) {
      throw new TypeError(
        "Worker repository is required.",
      );
    }

    if (!objectStorage) {
      throw new TypeError(
        "Worker object storage is required.",
      );
    }

    if (
      metricsRepository !==
        null &&
      typeof metricsRepository
        .replaceIngestionMetrics !==
        "function"
    ) {
      throw new TypeError(
        "Worker metrics repository is invalid.",
      );
    }

    if (
      comparisonRepository !==
        null &&
      typeof comparisonRepository
        .refreshForIngestion !==
        "function"
    ) {
      throw new TypeError(
        "Worker comparison repository is invalid.",
      );
    }

    if (
      findingsRepository !==
        null &&
      typeof findingsRepository
        .refreshForIngestion !==
        "function"
    ) {
      throw new TypeError(
        "Worker findings repository is invalid.",
      );
    }

    if (
      comparisonRepository &&
      !metricsRepository
    ) {
      throw new TypeError(
        "Worker comparison repository requires a metrics repository.",
      );
    }

    if (
      findingsRepository &&
      !comparisonRepository
    ) {
      throw new TypeError(
        "Worker findings repository requires a comparison repository.",
      );
    }

    if (
      typeof workerId !==
        "string" ||
      !workerId.trim()
    ) {
      throw new TypeError(
        "Worker ID is required.",
      );
    }

    if (
      !Number.isInteger(
        leaseSeconds,
      ) ||
      leaseSeconds < 10 ||
      leaseSeconds > 900
    ) {
      throw new TypeError(
        "Worker lease duration is invalid.",
      );
    }

    if (
      !Number.isInteger(
        pollIntervalMs,
      ) ||
      pollIntervalMs < 100 ||
      pollIntervalMs > 60_000
    ) {
      throw new TypeError(
        "Worker polling interval is invalid.",
      );
    }

    if (
      !Number.isInteger(
        heartbeatIntervalMs,
      ) ||
      heartbeatIntervalMs <
        1_000 ||
      heartbeatIntervalMs >
        60_000
    ) {
      throw new TypeError(
        "Worker heartbeat interval is invalid.",
      );
    }

    this.repository =
      repository;

    this.objectStorage =
      objectStorage;

    this.metricsRepository =
      metricsRepository;

    this.comparisonRepository =
      comparisonRepository;

    this.findingsRepository =
      findingsRepository;

    this.workerId =
      workerId.trim();

    this.leaseSeconds =
      leaseSeconds;

    this.pollIntervalMs =
      pollIntervalMs;

    this.heartbeatIntervalMs =
      heartbeatIntervalMs;

    this.onError =
      onError;

    this.lastHeartbeatAt =
      0;
  }

  async run({
    signal,
  } = {}) {
    await this.#heartbeat(
      "ready",
      true,
    );

    while (
      !signal?.aborted
    ) {
      let worked =
        false;

      try {
        worked =
          await this.runOnce();
      } catch (error) {
        this.onError(
          error,
        );
      }

      if (
        !worked &&
        !signal?.aborted
      ) {
        await delay(
          this.pollIntervalMs,
          signal,
        );
      }
    }

    await this.#heartbeat(
      "stopped",
      true,
    );
  }

  async runOnce() {
    await this.#heartbeat(
      "ready",
    );

    const job =
      await this.repository
        .leaseNext({
          workerId:
            this.workerId,

          leaseSeconds:
            this.leaseSeconds,
        });

    if (!job) {
      return false;
    }

    await this.#heartbeat(
      "busy",
      true,
    );

    try {
      await this.#processJob(
        job,
      );

      /*
       * The durable job only succeeds after
       * every production stage succeeds:
       *
       * storage verification
       * -> verified metrics
       * -> comparisons
       * -> findings
       */
      await this.repository
        .complete({
          jobId:
            job.id,

          workerId:
            this.workerId,
        });
    } catch (error) {
      await this.repository
        .fail({
          jobId:
            job.id,

          workerId:
            this.workerId,

          error,
        });

      this.onError(
        error,
      );
    } finally {
      await this.#heartbeat(
        "ready",
        true,
      );
    }

    return true;
  }

  async stop() {
    await this.#heartbeat(
      "stopping",
      true,
    );
  }

  async #processJob(
    job,
  ) {
    switch (
      job.jobType
    ) {
      case "ingestion.verify_storage":
        await this.#processVerifiedIngestion(
          job,
        );

        return;

      default:
        throw new WorkerProcessingError(
          `Unsupported worker job type: ${job.jobType}`,
          "UNSUPPORTED_JOB_TYPE",
        );
    }
  }

  async #processVerifiedIngestion(
    job,
  ) {
    const context =
      await this.repository
        .getIngestionContext({
          job,
        });

    validateIngestionContext(
      context,
    );

    const object =
      await this.objectStorage
        .getObject({
          key:
            context.rawObject
              .storageKey,
        });

    const body =
      normalizeObjectBody(
        object?.body,
      );

    /*
     * Never derive business intelligence from
     * bytes that fail immutable storage checks.
     */
    verifyRawObject({
      context,
      body,
    });

    /*
     * Storage-only worker mode remains supported
     * for isolated infrastructure testing.
     */
    if (
      !this.metricsRepository
    ) {
      return;
    }

    const contentType =
      String(
        context.rawObject
          .contentType ??
          "",
      )
        .trim()
        .toLowerCase();

    if (
      contentType !==
      "text/csv"
    ) {
      throw new WorkerProcessingError(
        "Verified metric extraction currently requires CSV raw data.",
        "METRIC_SOURCE_FORMAT_UNSUPPORTED",
      );
    }

    const metrics =
      deriveCsvMetrics({
        body,

        originalFilename:
          context.rawObject
            .originalFilename,
      });

    /*
     * Stage 1:
     * durable verified metrics.
     */
    await this.metricsRepository
      .replaceIngestionMetrics({
        organizationId:
          context.organizationId,

        ingestionRunId:
          context.ingestionRunId,

        metrics,
      });

    /*
     * Stage 2:
     * rebuild deterministic period-over-period
     * comparison history.
     */
    if (
      this.comparisonRepository
    ) {
      await this
        .comparisonRepository
        .refreshForIngestion({
          organizationId:
            context.organizationId,

          ingestionRunId:
            context.ingestionRunId,
        });
    }

    /*
     * Stage 3:
     * derive evidence-backed signals, risks,
     * opportunities and focus areas.
     *
     * Failure here prevents job completion.
     */
    if (
      this.findingsRepository
    ) {
      await this
        .findingsRepository
        .refreshForIngestion({
          organizationId:
            context.organizationId,

          ingestionRunId:
            context.ingestionRunId,
        });
    }
  }

  async #heartbeat(
    status,
    force = false,
  ) {
    const now =
      Date.now();

    if (
      !force &&
      now -
        this.lastHeartbeatAt <
        this.heartbeatIntervalMs
    ) {
      return;
    }

    await this.repository
      .heartbeat({
        workerId:
          this.workerId,

        status,

        metadata: {
          pid:
            process.pid,

          version:
            "production-worker-v4",

          capabilities: [
            "raw-object-verification",
            "csv-metric-extraction",
            "verified-metric-persistence",
            "historical-metric-comparisons",
            "verified-performance-findings",
          ],
        },
      });

    this.lastHeartbeatAt =
      now;
  }
}

export class WorkerProcessingError
  extends Error {
  constructor(
    message,
    code =
      "WORKER_PROCESSING_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "WorkerProcessingError";

    this.code =
      code;
  }
}

export function deriveCsvMetrics({
  body,
  originalFilename =
    "upload.csv",
}) {
  const buffer =
    normalizeObjectBody(
      body,
    );

  let rows;

  try {
    rows =
      parse(
        buffer,
        {
          bom:
            true,

          skip_empty_lines:
            true,

          relax_column_count:
            false,

          trim:
            true,
        },
      );
  } catch {
    throw new WorkerProcessingError(
      "Stored CSV could not be parsed for verified metric extraction.",
      "METRIC_CSV_PARSE_FAILED",
    );
  }

  if (
    !Array.isArray(
      rows,
    ) ||
    rows.length < 2
  ) {
    throw new WorkerProcessingError(
      "Stored CSV does not contain a header and at least one data row.",
      "METRIC_CSV_EMPTY",
    );
  }

  const headers =
    rows[0].map(
      (value) =>
        String(
          value ??
            "",
        ).trim(),
    );

  if (
    headers.some(
      (header) =>
        !header,
    )
  ) {
    throw new WorkerProcessingError(
      "Stored CSV contains an empty column name.",
      "METRIC_CSV_HEADER_INVALID",
    );
  }

  const normalizedHeaders =
    headers.map(
      (header) =>
        header.toLowerCase(),
    );

  if (
    new Set(
      normalizedHeaders,
    ).size !==
    normalizedHeaders.length
  ) {
    throw new WorkerProcessingError(
      "Stored CSV contains duplicate column names.",
      "METRIC_CSV_HEADER_INVALID",
    );
  }

  const dataRows =
    rows.slice(
      1,
    );

  const metrics =
    [];

  const reportCube = buildReportCube({
    columns: headers,
    rows: dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]]))),
  });

  for (
    let columnIndex = 0;
    columnIndex <
    headers.length;
    columnIndex += 1
  ) {
    const sourceColumn =
      headers[
        columnIndex
      ];

    if (
      shouldExcludeMetricColumn(
        sourceColumn,
      ) || !isAdditiveReportColumn(sourceColumn)
    ) {
      continue;
    }

    const values =
      dataRows.map(
        (row) =>
          String(
            row?.[
              columnIndex
            ] ??
              "",
          ).trim(),
      );

    const populatedValues =
      values.filter(
        (value) =>
          value !==
          "",
      );

    if (
      populatedValues.length ===
      0
    ) {
      continue;
    }

    const parsedValues =
      populatedValues.map(
        parseMetricDecimal,
      );

    if (
      parsedValues.some(
        (value) =>
          value ===
          null,
      )
    ) {
      continue;
    }

    let total =
      0n;

    for (
      const value of
        parsedValues
    ) {
      total +=
        value;
    }

    const metricValue =
      scaledIntegerToDecimal(
        total,
      );

    ensureMetricPrecision(
      metricValue,
      sourceColumn,
    );

    metrics.push({
      metricKey:
        `sum:${sourceColumn.toLowerCase()}`,

      label:
        humanizeColumn(
          sourceColumn,
        ),

      sourceColumn,

      aggregation:
        "sum",

      value:
        metricValue,

      sourceRowCount:
        dataRows.length,

      contributingRowCount:
        populatedValues.length,

      unit:
        inferMetricUnit(
          sourceColumn,
        ),

      evidence: {
        reportAnalytics: reportCube.metrics.some((metric) => metric.column === sourceColumn) ? {
          version: reportCube.version,
          rowCount: reportCube.rowCount,
          schemaFingerprint: reportCube.schemaFingerprint,
          omittedDimensions: reportCube.omittedDimensions,
          metric: reportCube.metrics.find((metric) => metric.column === sourceColumn),
        } : null,
        kind:
          "verified_numeric_aggregation",

        parser:
          "csv",

        parserVersion:
          "deterministic-v1",

        fileName:
          String(
            originalFilename ??
              "upload.csv",
          ),

        calculation:
          `sum(${sourceColumn})`,

        sourceColumn,

        sourceRowCount:
          dataRows.length,

        contributingRowCount:
          populatedValues.length,

        excludedBlankRowCount:
          dataRows.length -
          populatedValues.length,
      },
    });
  }

  return metrics;
}

function validateIngestionContext(
  context,
) {
  if (
    !context ||
    !context.organizationId ||
    !context.ingestionRunId ||
    !context.rawObject
  ) {
    throw new WorkerProcessingError(
      "Ingestion context is incomplete.",
      "INGESTION_CONTEXT_MISSING",
    );
  }

  if (
    context.ingestionStatus !==
    "validated"
  ) {
    throw new WorkerProcessingError(
      "Ingestion run is not in a processable state.",
      "INGESTION_NOT_PROCESSABLE",
    );
  }

  if (
    context.rawObject
      .status !==
    "accepted"
  ) {
    throw new WorkerProcessingError(
      "Raw object is not accepted.",
      "RAW_OBJECT_NOT_PROCESSABLE",
    );
  }

  if (
    !context.rawObject
      .storageKey
  ) {
    throw new WorkerProcessingError(
      "Raw object storage key is missing.",
      "RAW_OBJECT_CONTEXT_INVALID",
    );
  }

  if (
    !context.rawObject
      .checksumSha256
  ) {
    throw new WorkerProcessingError(
      "Raw object checksum is missing.",
      "RAW_OBJECT_CONTEXT_INVALID",
    );
  }

  if (
    !Number.isInteger(
      Number(
        context.rawObject
          .byteSize,
      ),
    ) ||
    Number(
      context.rawObject
        .byteSize,
    ) < 0
  ) {
    throw new WorkerProcessingError(
      "Raw object byte size is invalid.",
      "RAW_OBJECT_CONTEXT_INVALID",
    );
  }
}

function normalizeObjectBody(
  body,
) {
  if (
    Buffer.isBuffer(
      body,
    )
  ) {
    return body;
  }

  if (
    body instanceof
      Uint8Array
  ) {
    return Buffer.from(
      body,
    );
  }

  throw new WorkerProcessingError(
    "Stored raw object did not return binary content.",
    "RAW_OBJECT_BODY_INVALID",
  );
}

function verifyRawObject({
  context,
  body,
}) {
  if (
    body.byteLength !==
    Number(
      context.rawObject
        .byteSize,
    )
  ) {
    throw new WorkerProcessingError(
      "Stored raw object size does not match database metadata.",
      "RAW_OBJECT_SIZE_MISMATCH",
    );
  }

  const checksum =
    createHash(
      "sha256",
    )
      .update(
        body,
      )
      .digest(
        "hex",
      );

  if (
    checksum !==
    context.rawObject
      .checksumSha256
  ) {
    throw new WorkerProcessingError(
      "Stored raw object checksum does not match database metadata.",
      "RAW_OBJECT_CHECKSUM_MISMATCH",
    );
  }
}

function shouldExcludeMetricColumn(
  header,
) {
  const normalized =
    String(
      header ??
        "",
    )
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        " ",
      )
      .trim();

  if (!normalized) {
    return true;
  }

  const tokens =
    normalized.split(
      /\s+/,
    );

  const lastToken =
    tokens.at(
      -1,
    );

  if (
    [
      "id",
      "uuid",
      "guid",
      "sku",
      "barcode",
      "serial",
      "reference",
      "ref",
      "phone",
      "telephone",
      "mobile",
      "postcode",
      "postal",
      "zip",
      "date",
      "time",
      "timestamp",
      "year",
      "month",
      "day",
    ].includes(
      normalized,
    )
  ) {
    return true;
  }

  if (
    [
      "id",
      "uuid",
      "guid",
      "sku",
      "barcode",
      "serial",
      "reference",
      "ref",
      "date",
      "time",
      "timestamp",
    ].includes(
      lastToken,
    )
  ) {
    return true;
  }

  if (
    /\b(?:created|updated|deleted|ordered|paid|transaction|invoice|billing|shipping)\s+(?:date|time|timestamp)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /\b(?:account|order|invoice|customer|transaction|reference|serial)\s+(?:number|no)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return false;
}

function parseMetricDecimal(
  value,
) {
  const text =
    String(
      value ??
        "",
    ).trim();

  const match =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(
      text,
    );

  if (!match) {
    return null;
  }

  const sign =
    match[1] ===
    "-"
      ? -1n
      : 1n;

  const integerPart =
    match[2] ??
    "0";

  const fractionalPart =
    match[3] ??
    match[4] ??
    "";

  if (
    fractionalPart.length >
    METRIC_DECIMAL_SCALE
  ) {
    return null;
  }

  const integerDigits =
    integerPart
      .replace(
        /^0+/,
        "",
      )
      .length || 1;

  if (
    integerDigits >
    28
  ) {
    throw new WorkerProcessingError(
      "Numeric metric source exceeds supported precision.",
      "METRIC_VALUE_OUT_OF_RANGE",
    );
  }

  const fraction =
    fractionalPart
      .padEnd(
        METRIC_DECIMAL_SCALE,
        "0",
      );

  return (
    BigInt(
      integerPart,
    ) *
      METRIC_DECIMAL_FACTOR +
    BigInt(
      fraction ||
        "0",
    )
  ) * sign;
}

function scaledIntegerToDecimal(
  value,
) {
  const negative =
    value <
    0n;

  const absolute =
    negative
      ? -value
      : value;

  const integerPart =
    absolute /
    METRIC_DECIMAL_FACTOR;

  const fractionPart =
    absolute %
    METRIC_DECIMAL_FACTOR;

  const fraction =
    fractionPart
      .toString()
      .padStart(
        METRIC_DECIMAL_SCALE,
        "0",
      )
      .replace(
        /0+$/,
        "",
      );

  const text =
    fraction
      ? `${integerPart}.${fraction}`
      : integerPart.toString();

  if (
    negative &&
    absolute !==
      0n
  ) {
    return `-${text}`;
  }

  return text;
}

function ensureMetricPrecision(
  value,
  sourceColumn,
) {
  const normalized =
    String(
      value,
    ).replace(
      /^-/,
      "",
    );

  const [
    integerPart,
    fractionalPart = "",
  ] =
    normalized.split(
      ".",
    );

  const integerDigits =
    integerPart
      .replace(
        /^0+/,
        "",
      )
      .length || 1;

  if (
    integerDigits >
      28 ||
    fractionalPart.length >
      10 ||
    integerDigits +
      fractionalPart.length >
      38
  ) {
    throw new WorkerProcessingError(
      `Calculated metric for "${sourceColumn}" exceeds supported numeric precision.`,
      "METRIC_VALUE_OUT_OF_RANGE",
    );
  }
}

function inferMetricUnit(
  sourceColumn,
) {
  const normalized =
    String(
      sourceColumn,
    )
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        " ",
      );

  if (
    /\b(?:percent|percentage|rate|margin)\b/.test(
      normalized,
    )
  ) {
    return "percent";
  }

  if (
    /\b(?:quantity|qty|units|count)\b/.test(
      normalized,
    )
  ) {
    return "count";
  }

  return null;
}

function humanizeColumn(
  column,
) {
  return String(
    column,
  )
    .replace(
      /[_-]+/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim()
    .replace(
      /\b\w/g,
      (character) =>
        character.toUpperCase(),
    );
}

function delay(
  milliseconds,
  signal,
) {
  if (
    signal?.aborted
  ) {
    return Promise.resolve();
  }

  return new Promise(
    (resolve) => {
      let finished =
        false;

      const finish =
        () => {
          if (
            finished
          ) {
            return;
          }

          finished =
            true;

          signal?.removeEventListener(
            "abort",
            onAbort,
          );

          resolve();
        };

      const timer =
        setTimeout(
          finish,
          milliseconds,
        );

      const onAbort =
        () => {
          clearTimeout(
            timer,
          );

          finish();
        };

      signal?.addEventListener(
        "abort",
        onAbort,
        {
          once:
            true,
        },
      );
    },
  );
}
