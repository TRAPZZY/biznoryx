import {
  parse,
} from "csv-parse/sync";

import {
  AuthError,
} from "../auth/core.mjs";

import {
  createRawObjectIdentity,
} from "./raw-object-identity.mjs";

const MAX_UPLOAD_BYTES =
  25 * 1024 * 1024;

const MAX_BATCH_FILES = 10;

export class ProductionIngestionService {
  constructor({
    repository,
    objectStorage,
  }) {
    if (!repository) {
      throw new TypeError(
        "Ingestion repository is required.",
      );
    }

    if (!objectStorage) {
      throw new TypeError(
        "Object storage is required.",
      );
    }

    this.repository =
      repository;

    this.objectStorage =
      objectStorage;
    this.inflightObjectWrites =
      new Map();
  }

  async upload({
    organizationId,
    actorUserId,
    fileName,
    content,
    period,
    dataSeries =
      "Business data",
  }) {
    const normalizedFileName =
      requiredText(
        fileName,
        "File name is required.",
      );

    const normalizedSeries =
      requiredText(
        dataSeries,
        "Data series is required.",
      );

    validateRawContent(
      content,
    );

    if (
      !normalizedFileName
        .toLowerCase()
        .endsWith(".csv")
    ) {
      throw new AuthError(
        "Only CSV uploads are supported in the current production ingestion phase.",
        "VALIDATION_FAILED",
      );
    }

    const rawBytes =
      Buffer.from(
        content,
        "utf8",
      );

    if (
      rawBytes.byteLength >
      MAX_UPLOAD_BYTES
    ) {
      throw new AuthError(
        "Uploaded file exceeds the 25 MB limit.",
        "VALIDATION_FAILED",
      );
    }

    const parsed =
      parseCsv(content);

    const reportingPeriod =
      parseMonthlyPeriod(
        period,
      );

    /*
     * Create or reuse the tenant's manual
     * source and recurring data stream.
     */
    const source =
      await this.repository
        .ensureManualUploadSource({
          organizationId,
          actorUserId,
        });

    const stream =
      await this.repository
        .ensureStream({
          organizationId,
          actorUserId,

          dataSourceId:
            source.id,

          name:
            streamSlug(
              normalizedSeries,
            ),

          displayName:
            normalizedSeries,

          grain:
            "monthly",
        });

    /*
     * Calculate exactly the same storage
     * identity used by the PostgreSQL
     * repository.
     */
    const identity =
      createRawObjectIdentity({
        organizationId,

        originalFilename:
          normalizedFileName,

        content,
      });

    const writeLock =
      this.inflightObjectWrites.get(identity.storageKey) ?? Promise.resolve();

    let unlock = () => {};

    const currentLock =
      new Promise((resolve) => {
        unlock = resolve;
      });

    this.inflightObjectWrites.set(identity.storageKey, currentLock);

    let storedByThisAttempt = false;

    try {
      await writeLock;

      const existingObject =
        await this.objectStorage
          .headObject({
            key:
              identity.storageKey,
          });

      if (!existingObject.exists) {
        await this.objectStorage
          .putObject({
            key:
              identity.storageKey,

            body:
              rawBytes,

            contentType:
              "text/csv",

            metadata: {
              organization:
                organizationId,

              checksum:
                identity
                  .checksumSha256,
            },
          });

        storedByThisAttempt =
          true;
      }

      const result =
        await this.repository
          .registerRawUpload({
            organizationId,
            actorUserId,

            dataSourceId:
              source.id,

            dataStreamId:
              stream.id,

            upload: {
              originalFilename:
                normalizedFileName,

              contentType:
                "text/csv",

              content,

              byteSize:
                rawBytes.byteLength,

              rowCount:
                parsed.rowCount,

              columns:
                parsed.columns,
            },

            reportingPeriod,
          });

      if (
        result.ingestionRun
          .status ===
          "rejected" &&
        storedByThisAttempt
      ) {
        await safeDeleteObject({
          objectStorage:
            this.objectStorage,

          key:
            identity.storageKey,
        });
      }

      return result;
    } catch (error) {
      if (storedByThisAttempt) {
        await safeDeleteObject({
          objectStorage:
            this.objectStorage,

          key:
            identity.storageKey,
        });
      }

      throw error;
    } finally {
      unlock();

      if (
        this.inflightObjectWrites.get(identity.storageKey) === currentLock
      ) {
        this.inflightObjectWrites.delete(identity.storageKey);
      }
    }
  }

  async uploadBatch({
    organizationId,
    actorUserId,
    files,
    period,
    dataSeries =
      "Business data",
  }) {
    if (
      !Array.isArray(files) ||
      files.length === 0
    ) {
      throw new AuthError(
        "At least one file is required.",
        "VALIDATION_FAILED",
      );
    }

    if (
      files.length >
      MAX_BATCH_FILES
    ) {
      throw new AuthError(
        `A maximum of ${MAX_BATCH_FILES} files can be uploaded in one batch.`,
        "VALIDATION_FAILED",
      );
    }

    const uploads = [];

    for (
      const file of files
    ) {
      const result =
        await this.upload({
          organizationId,
          actorUserId,

          fileName:
            file?.fileName,

          content:
            file?.content,

          period,

          dataSeries,
        });

      uploads.push(
        result,
      );
    }

    return uploads;
  }
}

function parseCsv(content) {
  let records;

  try {
    records =
      parse(content, {
        bom: true,

        skip_empty_lines:
          true,

        relax_column_count:
          false,

        trim: true,
      });
  } catch {
    throw new AuthError(
      "The CSV file could not be parsed.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !Array.isArray(records) ||
    records.length < 2
  ) {
    throw new AuthError(
      "The CSV file must contain a header and at least one data row.",
      "VALIDATION_FAILED",
    );
  }

  const rawHeaders =
    records[0];

  if (
    !Array.isArray(
      rawHeaders,
    ) ||
    rawHeaders.length === 0
  ) {
    throw new AuthError(
      "The CSV file does not contain a valid header row.",
      "VALIDATION_FAILED",
    );
  }

  const headers =
    rawHeaders.map(
      (header) =>
        String(
          header ?? "",
        ).trim(),
    );

  if (
    headers.some(
      (header) =>
        !header,
    )
  ) {
    throw new AuthError(
      "The CSV file contains an empty column name.",
      "VALIDATION_FAILED",
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
    throw new AuthError(
      "The CSV file contains duplicate column names.",
      "VALIDATION_FAILED",
    );
  }

  const rows =
    records.slice(1);

  /*
   * csv-parse already rejects inconsistent
   * column counts, but keep this explicit
   * guard at the service boundary.
   */
  for (
    const row of rows
  ) {
    if (
      !Array.isArray(row) ||
      row.length !==
        headers.length
    ) {
      throw new AuthError(
        "The CSV file contains rows with an inconsistent number of columns.",
        "VALIDATION_FAILED",
      );
    }
  }

  const columns =
    headers.map(
      (
        name,
        index,
      ) => {
        const values =
          rows.map(
            (row) =>
              row[index],
          );

        return {
          name,

          type:
            inferColumnType(
              values,
            ),

          required:
            values.every(
              (value) =>
                String(
                  value ?? "",
                ).trim() !==
                "",
            ),
        };
      },
    );

  return {
    rowCount:
      rows.length,

    columns,
  };
}

function inferColumnType(
  values,
) {
  const populated =
    values
      .map(
        (value) =>
          String(
            value ?? "",
          ).trim(),
      )
      .filter(Boolean);

  if (
    populated.length === 0
  ) {
    return "text";
  }

  if (
    populated.every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(
          value,
        ),
    )
  ) {
    return "date";
  }

  if (
    populated.every(
      (value) =>
        [
          "true",
          "false",
          "yes",
          "no",
        ].includes(
          value.toLowerCase(),
        ),
    )
  ) {
    return "boolean";
  }

  if (
    populated.every(
      (value) =>
        isDecimal(
          value,
        ),
    )
  ) {
    return "decimal";
  }

  return "text";
}

function isDecimal(value) {
  const normalized =
    String(value)
      .trim()
      .replace(
        /,/g,
        "",
      );

  return /^-?\d+(?:\.\d+)?$/.test(
    normalized,
  );
}

function parseMonthlyPeriod(
  value,
) {
  const period =
    requiredText(
      value,
      "Reporting period is required.",
    );

  const match =
    /^(\d{4})-(\d{2})$/.exec(
      period,
    );

  if (!match) {
    throw new AuthError(
      "Reporting period must use YYYY-MM format.",
      "VALIDATION_FAILED",
    );
  }

  const year =
    Number(
      match[1],
    );

  const month =
    Number(
      match[2],
    );

  if (
    !Number.isInteger(
      year,
    ) ||
    year < 2000 ||
    year > 2200 ||
    month < 1 ||
    month > 12
  ) {
    throw new AuthError(
      "Reporting period is invalid.",
      "VALIDATION_FAILED",
    );
  }

  const monthText =
    String(month).padStart(
      2,
      "0",
    );

  const periodStart =
    `${year}-${monthText}-01`;

  const lastDay =
    new Date(
      Date.UTC(
        year,
        month,
        0,
      ),
    ).getUTCDate();

  const periodEnd =
    `${year}-${monthText}-${String(
      lastDay,
    ).padStart(
      2,
      "0",
    )}`;

  const label =
    new Intl.DateTimeFormat(
      "en",
      {
        month:
          "long",

        year:
          "numeric",

        timeZone:
          "UTC",
      },
    ).format(
      new Date(
        Date.UTC(
          year,
          month - 1,
          1,
        ),
      ),
    );

  return {
    periodStart,
    periodEnd,
    label,
  };
}

function streamSlug(value) {
  const slug =
    requiredText(
      value,
      "Data series is required.",
    )
      .toLowerCase()
      .normalize(
        "NFKD",
      )
      .replace(
        /[\u0300-\u036f]/g,
        "",
      )
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-+|-+$/g,
        "",
      )
      .slice(
        0,
        80,
      );

  if (!slug) {
    throw new AuthError(
      "Data series must contain letters or numbers.",
      "VALIDATION_FAILED",
    );
  }

  return slug;
}

function validateRawContent(
  content,
) {
  if (
    typeof content !==
      "string" ||
    content.length === 0 ||
    !content.trim()
  ) {
    throw new AuthError(
      "File content is required.",
      "VALIDATION_FAILED",
    );
  }
}

function requiredText(
  value,
  message,
) {
  const text =
    String(
      value ?? "",
    ).trim();

  if (!text) {
    throw new AuthError(
      message,
      "VALIDATION_FAILED",
    );
  }

  return text;
}

async function safeDeleteObject({
  objectStorage,
  key,
}) {
  try {
    await objectStorage
      .deleteObject({
        key,
      });
  } catch {
    /*
     * Preserve the original ingestion error.
     * Failed cleanup will later be surfaced
     * through storage reconciliation and
     * operational monitoring.
     */
  }
}