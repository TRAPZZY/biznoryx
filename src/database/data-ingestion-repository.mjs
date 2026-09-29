import {
  createHash,
  randomUUID,
} from "node:crypto";

import {
  createRawObjectIdentity,
} from "../ingestion/raw-object-identity.mjs";

import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const ALLOWED_EXTENSIONS = new Set([
  "csv",
  "json",
  "xlsx",
]);

const ALLOWED_CONTENT_TYPES = new Set([
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const ALLOWED_GRAINS = new Set([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "ad_hoc",
]);

export class PostgresDataIngestionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async ensureManualUploadSource({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        const existing =
          await client.query(
            `select
               id,
               organization_id,
               name,
               source_type,
               description,
               status,
               created_by_user_id,
               created_at,
               updated_at
             from data_sources
             where organization_id = $1
               and source_type = 'manual_upload'
               and name = 'Manual uploads'
             limit 1`,
            [organizationId],
          );

        if (existing.rows[0]) {
          return mapDataSource(
            existing.rows[0],
          );
        }

        const id = randomUUID();

        const created =
          await client.query(
            `insert into data_sources (
               id,
               organization_id,
               name,
               source_type,
               description,
               status,
               created_by_user_id
             )
             values (
               $1,
               $2,
               'Manual uploads',
               'manual_upload',
               'Files uploaded directly through BIZNORYX.',
               'active',
               $3
             )
             returning
               id,
               organization_id,
               name,
               source_type,
               description,
               status,
               created_by_user_id,
               created_at,
               updated_at`,
            [
              id,
              organizationId,
              actorUserId,
            ],
          );

        await writeAudit({
          client,
          organizationId,
          actorUserId,
          eventType:
            "data_source.created",
          targetType:
            "data_source",
          targetId: id,
        });

        return mapDataSource(
          created.rows[0],
        );
      },
    );
  }

  async ensureStream({
    organizationId,
    actorUserId,
    dataSourceId,
    name,
    displayName,
    grain = "monthly",
  }) {
    const streamName =
      clean(name);

    const streamDisplayName =
      clean(displayName);

    if (!streamName) {
      throw new AuthError(
        "Data stream name is required.",
        "VALIDATION_FAILED",
      );
    }

    if (!streamDisplayName) {
      throw new AuthError(
        "Data stream display name is required.",
        "VALIDATION_FAILED",
      );
    }

    if (
      !ALLOWED_GRAINS.has(
        grain,
      )
    ) {
      throw new AuthError(
        "Unsupported data stream grain.",
        "VALIDATION_FAILED",
      );
    }

    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        await requireOwnedSource({
          client,
          organizationId,
          dataSourceId,
        });

        const existing =
          await client.query(
            `select
               id,
               organization_id,
               data_source_id,
               name,
               display_name,
               grain,
               expected_schema_fingerprint,
               active_schema_version_id,
               created_by_user_id,
               created_at,
               updated_at
             from data_streams
             where organization_id = $1
               and data_source_id = $2
               and name = $3
             limit 1`,
            [
              organizationId,
              dataSourceId,
              streamName,
            ],
          );

        if (existing.rows[0]) {
          return mapDataStream(
            existing.rows[0],
          );
        }

        const id = randomUUID();

        const created =
          await client.query(
            `insert into data_streams (
               id,
               organization_id,
               data_source_id,
               name,
               display_name,
               grain,
               created_by_user_id
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7
             )
             returning
               id,
               organization_id,
               data_source_id,
               name,
               display_name,
               grain,
               expected_schema_fingerprint,
               active_schema_version_id,
               created_by_user_id,
               created_at,
               updated_at`,
            [
              id,
              organizationId,
              dataSourceId,
              streamName,
              streamDisplayName,
              grain,
              actorUserId,
            ],
          );

        await writeAudit({
          client,
          organizationId,
          actorUserId,
          eventType:
            "data_stream.created",
          targetType:
            "data_stream",
          targetId: id,
        });

        return mapDataStream(
          created.rows[0],
        );
      },
    );
  }

  async registerRawUpload({
    organizationId,
    actorUserId,
    dataSourceId,
    dataStreamId,
    upload,
    reportingPeriod,
  }) {
    validateUpload(upload);

    validateReportingPeriod(
      reportingPeriod,
    );

    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        await requireOwnedSource({
          client,
          organizationId,
          dataSourceId,
        });

        const stream =
          await requireOwnedStream({
            client,
            organizationId,
            dataSourceId,
            dataStreamId,
          });

        const validations =
          validateFile(upload);

        /*
         * The checksum and storage key now
         * come from one shared deterministic
         * implementation.
         *
         * The storage key no longer depends
         * on the database raw-object UUID.
         */
        const {
          checksumSha256:
            checksum,
          storageKey,
        } =
          createRawObjectIdentity({
            organizationId,

            originalFilename:
              upload.originalFilename,

            content:
              upload.content,
          });

        /*
         * Raw source files are immutable.
         * Re-uploading identical bytes into
         * the same organization is rejected.
         */
        const existingObject =
          await client.query(
            `select
               id
             from raw_data_objects
             where organization_id = $1
               and checksum_sha256 = $2
             limit 1`,
            [
              organizationId,
              checksum,
            ],
          );

        if (existingObject.rows[0]) {
          throw new AuthError(
            "This file has already been uploaded.",
            "VALIDATION_FAILED",
          );
        }

        const rawObjectId =
          randomUUID();

        const rawObjectStatus =
          validations.some(
            (item) =>
              item.severity ===
              "error",
          )
            ? "rejected"
            : "accepted";

        const rawObject =
          await client.query(
            `insert into raw_data_objects (
               id,
               organization_id,
               storage_key,
               original_filename,
               content_type,
               byte_size,
               checksum_sha256,
               status,
               created_by_user_id
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7,
               $8,
               $9
             )
             returning
               id,
               organization_id,
               storage_key,
               original_filename,
               content_type,
               byte_size,
               checksum_sha256,
               status,
               created_by_user_id,
               created_at`,
            [
              rawObjectId,
              organizationId,
              storageKey,

              clean(
                upload.originalFilename,
              ),

              clean(
                upload.contentType,
              ),

              upload.byteSize,
              checksum,
              rawObjectStatus,
              actorUserId,
            ],
          );

        const period =
          await ensureReportingPeriod({
            client,
            organizationId,
            dataStreamId,
            reportingPeriod,
          });

        const normalizedColumns =
          normalizeColumns(
            upload.columns,
          );

        if (
          normalizedColumns.length ===
          0
        ) {
          throw new AuthError(
            "Upload columns are invalid.",
            "VALIDATION_FAILED",
          );
        }

        const schemaFingerprint =
          fingerprintSchema(
            normalizedColumns,
          );

        let schemaVersion = null;
        let schemaDrift = "none";

        let runStatus =
          validations.some(
            (item) =>
              item.severity ===
              "error",
          )
            ? "rejected"
            : "validated";

        if (
          runStatus ===
          "validated"
        ) {
          const activeSchema =
            await activeStreamSchema({
              client,
              organizationId,
              stream,
            });

          /*
           * The first accepted upload for a
           * recurring stream establishes its
           * initial schema baseline.
           */
          if (!activeSchema) {
            schemaVersion =
              await createInitialSchema({
                client,
                organizationId,
                actorUserId,
                dataStreamId,
                schemaFingerprint,

                columns:
                  normalizedColumns,
              });

            await client.query(
              `update data_streams
               set expected_schema_fingerprint = $2,
                   active_schema_version_id = $3,
                   updated_at = now()
               where id = $1`,
              [
                dataStreamId,
                schemaFingerprint,
                schemaVersion.id,
              ],
            );
          } else if (
            activeSchema
              .schemaFingerprint ===
            schemaFingerprint
          ) {
            schemaVersion =
              activeSchema;
          } else {
            const drift =
              classifySchemaDrift(
                activeSchema.columns,
                normalizedColumns,
              );

            schemaDrift =
              drift;

            if (
              drift ===
              "breaking"
            ) {
              runStatus =
                "rejected";

              validations.push({
                severity:
                  "error",

                code:
                  "BREAKING_SCHEMA_DRIFT",

                message:
                  "The uploaded file is missing required columns or changes an existing column type.",
              });
            } else {
              schemaVersion =
                await findOrCreateSchemaVersion({
                  client,
                  organizationId,
                  actorUserId,
                  dataStreamId,
                  schemaFingerprint,

                  columns:
                    normalizedColumns,
                });

              await client.query(
                `update data_streams
                 set expected_schema_fingerprint = $2,
                     active_schema_version_id = $3,
                     updated_at = now()
                 where id = $1`,
                [
                  dataStreamId,
                  schemaFingerprint,
                  schemaVersion.id,
                ],
              );
            }
          }
        }

        /*
         * A file can pass extension/content
         * validation but later fail schema
         * validation. Keep the raw-object
         * status consistent with the run.
         */
        if (
          runStatus ===
            "rejected" &&
          rawObjectStatus !==
            "rejected"
        ) {
          await client.query(
            `update raw_data_objects
             set status = 'rejected'
             where id = $1`,
            [rawObjectId],
          );
        }

        const ingestionRunId =
          randomUUID();

        const ingestionRun =
          await client.query(
            `insert into ingestion_runs (
               id,
               organization_id,
               data_source_id,
               data_stream_id,
               reporting_period_id,
               raw_data_object_id,
               schema_version_id,
               status,
               schema_drift,
               row_count,
               column_count,
               created_by_user_id
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7,
               $8,
               $9,
               $10,
               $11,
               $12
             )
             returning
               id,
               organization_id,
               data_source_id,
               data_stream_id,
               reporting_period_id,
               raw_data_object_id,
               schema_version_id,
               status,
               schema_drift,
               row_count,
               column_count,
               created_by_user_id,
               created_at`,
            [
              ingestionRunId,
              organizationId,
              dataSourceId,
              dataStreamId,
              period.id,
              rawObjectId,

              schemaVersion?.id ??
                null,

              runStatus,
              schemaDrift,
              upload.rowCount,
              normalizedColumns.length,
              actorUserId,
            ],
          );

        const validationResults =
          [];

        for (
          const item of
          validations
        ) {
          const id =
            randomUUID();

          const result =
            await client.query(
              `insert into ingestion_validation_results (
                 id,
                 organization_id,
                 ingestion_run_id,
                 severity,
                 code,
                 message
               )
               values (
                 $1,
                 $2,
                 $3,
                 $4,
                 $5,
                 $6
               )
               returning
                 id,
                 organization_id,
                 ingestion_run_id,
                 severity,
                 code,
                 message,
                 created_at`,
              [
                id,
                organizationId,
                ingestionRunId,
                item.severity,
                item.code,
                item.message,
              ],
            );

          validationResults.push(
            mapValidationResult(
              result.rows[0],
            ),
          );
        }

        await writeAudit({
          client,
          organizationId,
          actorUserId,

          eventType:
            runStatus ===
            "validated"
              ? "ingestion_run.validated"
              : "ingestion_run.rejected",

          targetType:
            "ingestion_run",

          targetId:
            ingestionRunId,
        });

        /*
         * Reload the stream because its
         * active schema may have changed
         * during this transaction.
         */
        const currentStream =
          await client.query(
            `select
               id,
               organization_id,
               data_source_id,
               name,
               display_name,
               grain,
               expected_schema_fingerprint,
               active_schema_version_id,
               created_by_user_id,
               created_at,
               updated_at
             from data_streams
             where id = $1
               and organization_id = $2
             limit 1`,
            [
              dataStreamId,
              organizationId,
            ],
          );

        return {
          dataStream:
            mapDataStream(
              currentStream.rows[0] ??
                stream,
            ),

          reportingPeriod:
            period,

          rawObject:
            mapRawObject(
              rawObject.rows[0],
              runStatus,
            ),

          ingestionRun:
            mapIngestionRun(
              ingestionRun.rows[0],
            ),

          schemaVersion,

          validationResults,
        };
      },
    );
  }

  async listUploads({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireReadAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `select
               ir.id,
               ir.status,
               ir.schema_drift,
               ir.row_count,
               ir.column_count,
               ir.created_at,

               rdo.id as raw_object_id,
               rdo.storage_key,
               rdo.original_filename,
               rdo.content_type,
               rdo.byte_size,
               rdo.checksum_sha256,
               rdo.status as raw_object_status,

               rp.id as reporting_period_id,
               rp.label as period_label,
               rp.period_start,
               rp.period_end,

               ds.id as data_stream_id,
               ds.name as data_stream_name,
               ds.display_name as data_stream_display_name

             from ingestion_runs ir

             join raw_data_objects rdo
               on rdo.id =
                  ir.raw_data_object_id

             join reporting_periods rp
               on rp.id =
                  ir.reporting_period_id

             join data_streams ds
               on ds.id =
                  ir.data_stream_id

             where ir.organization_id = $1

             order by
               ir.created_at desc`,
            [organizationId],
          );

        return result.rows.map(
          (row) => ({
            id:
              row.id,

            status:
              row.status,

            schemaDrift:
              row.schema_drift,

            rowCount:
              Number(
                row.row_count ??
                0,
              ),

            columnCount:
              Number(
                row.column_count ??
                0,
              ),

            createdAt:
              row.created_at,

            rawObject: {
              id:
                row.raw_object_id,

              storageKey:
                row.storage_key,

              originalFilename:
                row.original_filename,

              contentType:
                row.content_type,

              byteSize:
                Number(
                  row.byte_size ??
                  0,
                ),

              checksumSha256:
                row.checksum_sha256,

              status:
                row.raw_object_status,
            },

            reportingPeriod: {
              id:
                row.reporting_period_id,

              label:
                row.period_label,

              periodStart:
                row.period_start,

              periodEnd:
                row.period_end,
            },

            dataStream: {
              id:
                row.data_stream_id,

              name:
                row.data_stream_name,

              displayName:
                row.data_stream_display_name,
            },
          }),
        );
      },
    );
  }
}

async function requireWriteAccess({
  client,
  organizationId,
  actorUserId,
}) {
  const role =
    await membershipRole({
      client,
      organizationId,
      actorUserId,
    });

  const capabilities =
    ROLE_CAPABILITIES[role] ??
    [];

  if (
    !capabilities.includes(
      CAPABILITIES
        .WRITE_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.write",
      "CAPABILITY_DENIED",
    );
  }
}

async function requireReadAccess({
  client,
  organizationId,
  actorUserId,
}) {
  const role =
    await membershipRole({
      client,
      organizationId,
      actorUserId,
    });

  const capabilities =
    ROLE_CAPABILITIES[role] ??
    [];

  if (
    !capabilities.includes(
      CAPABILITIES
        .READ_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.read",
      "CAPABILITY_DENIED",
    );
  }
}

async function membershipRole({
  client,
  organizationId,
  actorUserId,
}) {
  const result =
    await client.query(
      `select
         role
       from organization_memberships
       where organization_id = $1
         and user_id = $2
         and status = 'active'
       limit 1`,
      [
        organizationId,
        actorUserId,
      ],
    );

  const membership =
    result.rows[0];

  if (!membership) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  return membership.role;
}

async function requireOwnedSource({
  client,
  organizationId,
  dataSourceId,
}) {
  const result =
    await client.query(
      `select
         id
       from data_sources
       where id = $1
         and organization_id = $2
       limit 1`,
      [
        dataSourceId,
        organizationId,
      ],
    );

  if (!result.rows[0]) {
    throw new AuthError(
      "Data source was not found.",
      "ORG_ACCESS_DENIED",
    );
  }
}

async function requireOwnedStream({
  client,
  organizationId,
  dataSourceId,
  dataStreamId,
}) {
  const result =
    await client.query(
      `select
         id,
         organization_id,
         data_source_id,
         name,
         display_name,
         grain,
         expected_schema_fingerprint,
         active_schema_version_id,
         created_by_user_id,
         created_at,
         updated_at
       from data_streams
       where id = $1
         and organization_id = $2
         and data_source_id = $3
       limit 1`,
      [
        dataStreamId,
        organizationId,
        dataSourceId,
      ],
    );

  if (!result.rows[0]) {
    throw new AuthError(
      "Data stream was not found.",
      "ORG_ACCESS_DENIED",
    );
  }

  return result.rows[0];
}

async function ensureReportingPeriod({
  client,
  organizationId,
  dataStreamId,
  reportingPeriod,
}) {
  const existing =
    await client.query(
      `select
         id,
         organization_id,
         data_stream_id,
         period_start,
         period_end,
         label,
         created_at
       from reporting_periods
       where organization_id = $1
         and data_stream_id = $2
         and period_start = $3
         and period_end = $4
       limit 1`,
      [
        organizationId,
        dataStreamId,
        reportingPeriod.periodStart,
        reportingPeriod.periodEnd,
      ],
    );

  if (existing.rows[0]) {
    return mapReportingPeriod(
      existing.rows[0],
    );
  }

  const id =
    randomUUID();

  const created =
    await client.query(
      `insert into reporting_periods (
         id,
         organization_id,
         data_stream_id,
         period_start,
         period_end,
         label
       )
       values (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6
       )
       returning
         id,
         organization_id,
         data_stream_id,
         period_start,
         period_end,
         label,
         created_at`,
      [
        id,
        organizationId,
        dataStreamId,
        reportingPeriod.periodStart,
        reportingPeriod.periodEnd,

        clean(
          reportingPeriod.label,
        ),
      ],
    );

  return mapReportingPeriod(
    created.rows[0],
  );
}

async function activeStreamSchema({
  client,
  organizationId,
  stream,
}) {
  if (
    !stream
      .active_schema_version_id
  ) {
    return null;
  }

  const result =
    await client.query(
      `select
         id,
         organization_id,
         data_stream_id,
         version,
         schema_fingerprint,
         columns,
         created_by_user_id,
         created_at
       from stream_schema_versions
       where id = $1
         and organization_id = $2
       limit 1`,
      [
        stream
          .active_schema_version_id,

        organizationId,
      ],
    );

  return result.rows[0]
    ? mapSchemaVersion(
        result.rows[0],
      )
    : null;
}

async function createInitialSchema({
  client,
  organizationId,
  actorUserId,
  dataStreamId,
  schemaFingerprint,
  columns,
}) {
  return createSchemaVersion({
    client,
    organizationId,
    actorUserId,
    dataStreamId,
    schemaFingerprint,
    columns,
    version: 1,
  });
}

async function findOrCreateSchemaVersion({
  client,
  organizationId,
  actorUserId,
  dataStreamId,
  schemaFingerprint,
  columns,
}) {
  const existing =
    await client.query(
      `select
         id,
         organization_id,
         data_stream_id,
         version,
         schema_fingerprint,
         columns,
         created_by_user_id,
         created_at
       from stream_schema_versions
       where organization_id = $1
         and data_stream_id = $2
         and schema_fingerprint = $3
       limit 1`,
      [
        organizationId,
        dataStreamId,
        schemaFingerprint,
      ],
    );

  if (existing.rows[0]) {
    return mapSchemaVersion(
      existing.rows[0],
    );
  }

  const versionResult =
    await client.query(
      `select
         coalesce(
           max(version),
           0
         ) + 1 as next_version
       from stream_schema_versions
       where organization_id = $1
         and data_stream_id = $2`,
      [
        organizationId,
        dataStreamId,
      ],
    );

  return createSchemaVersion({
    client,
    organizationId,
    actorUserId,
    dataStreamId,
    schemaFingerprint,
    columns,

    version:
      Number(
        versionResult.rows[0]
          .next_version,
      ),
  });
}

async function createSchemaVersion({
  client,
  organizationId,
  actorUserId,
  dataStreamId,
  schemaFingerprint,
  columns,
  version,
}) {
  const id =
    randomUUID();

  const result =
    await client.query(
      `insert into stream_schema_versions (
         id,
         organization_id,
         data_stream_id,
         version,
         schema_fingerprint,
         columns,
         created_by_user_id
       )
       values (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6::jsonb,
         $7
       )
       returning
         id,
         organization_id,
         data_stream_id,
         version,
         schema_fingerprint,
         columns,
         created_by_user_id,
         created_at`,
      [
        id,
        organizationId,
        dataStreamId,
        version,
        schemaFingerprint,
        JSON.stringify(columns),
        actorUserId,
      ],
    );

  return mapSchemaVersion(
    result.rows[0],
  );
}

function validateUpload(upload) {
  if (
    !upload ||
    typeof upload !==
      "object" ||
    Array.isArray(upload)
  ) {
    throw new AuthError(
      "Upload metadata is required.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !clean(
      upload.originalFilename,
    )
  ) {
    throw new AuthError(
      "Upload filename is required.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !clean(
      upload.contentType,
    )
  ) {
    throw new AuthError(
      "Upload content type is required.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !Number.isInteger(
      upload.byteSize,
    ) ||
    upload.byteSize <= 0
  ) {
    throw new AuthError(
      "Upload byte size must be greater than zero.",
      "VALIDATION_FAILED",
    );
  }

  const validContent =
    typeof upload.content ===
      "string" ||
    Buffer.isBuffer(
      upload.content,
    ) ||
    upload.content instanceof
      Uint8Array;

  if (!validContent) {
    throw new AuthError(
      "Upload content is required.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !Number.isInteger(
      upload.rowCount,
    ) ||
    upload.rowCount < 0
  ) {
    throw new AuthError(
      "Upload row count is invalid.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !Array.isArray(
      upload.columns,
    ) ||
    upload.columns.length === 0
  ) {
    throw new AuthError(
      "Upload columns are required.",
      "VALIDATION_FAILED",
    );
  }
}

function validateReportingPeriod(
  reportingPeriod,
) {
  if (
    !reportingPeriod ||
    typeof reportingPeriod !==
      "object" ||
    Array.isArray(
      reportingPeriod,
    )
  ) {
    throw new AuthError(
      "Reporting period is required.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !clean(
      reportingPeriod.periodStart,
    ) ||
    !clean(
      reportingPeriod.periodEnd,
    ) ||
    !clean(
      reportingPeriod.label,
    )
  ) {
    throw new AuthError(
      "Reporting period is incomplete.",
      "VALIDATION_FAILED",
    );
  }

  const start =
    new Date(
      `${reportingPeriod.periodStart}T00:00:00Z`,
    );

  const end =
    new Date(
      `${reportingPeriod.periodEnd}T00:00:00Z`,
    );

  if (
    Number.isNaN(
      start.getTime(),
    ) ||
    Number.isNaN(
      end.getTime(),
    ) ||
    end < start
  ) {
    throw new AuthError(
      "Reporting period is invalid.",
      "VALIDATION_FAILED",
    );
  }
}

function validateFile(upload) {
  const results = [];

  const extension =
    fileExtension(
      upload.originalFilename,
    );

  if (
    !ALLOWED_EXTENSIONS.has(
      extension,
    )
  ) {
    results.push({
      severity:
        "error",

      code:
        "FILE_EXTENSION_NOT_ALLOWED",

      message:
        "The uploaded file extension is not allowed.",
    });
  }

  if (
    !ALLOWED_CONTENT_TYPES.has(
      clean(
        upload.contentType,
      ).toLowerCase(),
    )
  ) {
    results.push({
      severity:
        "error",

      code:
        "CONTENT_TYPE_NOT_ALLOWED",

      message:
        "The uploaded content type is not allowed.",
    });
  }

  return results;
}

function normalizeColumns(columns) {
  return columns
    .map(
      (column) => ({
        name:
          clean(
            column?.name,
          ).toLowerCase(),

        type:
          clean(
            column?.type ??
            "text",
          ).toLowerCase(),

        required:
          Boolean(
            column?.required,
          ),
      }),
    )
    .filter(
      (column) =>
        Boolean(
          column.name,
        ),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(
          right.name,
        ),
    );
}

function fingerprintSchema(
  columns,
) {
  return createHash(
    "sha256",
  )
    .update(
      JSON.stringify(
        columns,
      ),
    )
    .digest("hex");
}

function classifySchemaDrift(
  baselineColumns,
  incomingColumns,
) {
  const baseline =
    new Map(
      baselineColumns.map(
        (column) => [
          column.name,
          column,
        ],
      ),
    );

  const incoming =
    new Map(
      incomingColumns.map(
        (column) => [
          column.name,
          column,
        ],
      ),
    );

  for (
    const [
      name,
      column,
    ] of baseline
  ) {
    const current =
      incoming.get(name);

    if (!current) {
      if (
        column.required
      ) {
        return "breaking";
      }

      continue;
    }

    if (
      current.type !==
      column.type
    ) {
      return "breaking";
    }
  }

  if (
    baseline.size ===
    incoming.size
  ) {
    return "none";
  }

  return "compatible";
}

async function writeAudit({
  client,
  organizationId,
  actorUserId,
  eventType,
  targetType,
  targetId,
}) {
  await client.query(
    `insert into audit_events (
       organization_id,
       actor_user_id,
       event_type,
       target_type,
       target_id
     )
     values (
       $1,
       $2,
       $3,
       $4,
       $5
     )`,
    [
      organizationId,
      actorUserId,
      eventType,
      targetType,
      targetId,
    ],
  );
}

function fileExtension(
  filename,
) {
  const name =
    clean(filename);

  const separator =
    name.lastIndexOf(".");

  if (
    separator <= 0 ||
    separator ===
      name.length - 1
  ) {
    return "";
  }

  return name
    .slice(
      separator + 1,
    )
    .toLowerCase();
}

function mapDataSource(row) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    name:
      row.name,

    sourceType:
      row.source_type,

    description:
      row.description,

    status:
      row.status,

    createdByUserId:
      row.created_by_user_id,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapDataStream(row) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    dataSourceId:
      row.data_source_id,

    name:
      row.name,

    displayName:
      row.display_name,

    grain:
      row.grain,

    expectedSchemaFingerprint:
      row.expected_schema_fingerprint,

    activeSchemaVersionId:
      row.active_schema_version_id,

    createdByUserId:
      row.created_by_user_id,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapReportingPeriod(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    dataStreamId:
      row.data_stream_id,

    periodStart:
      row.period_start,

    periodEnd:
      row.period_end,

    label:
      row.label,

    createdAt:
      row.created_at,
  };
}

function mapRawObject(
  row,
  runStatus,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    storageKey:
      row.storage_key,

    originalFilename:
      row.original_filename,

    contentType:
      row.content_type,

    byteSize:
      Number(
        row.byte_size ??
        0,
      ),

    checksumSha256:
      row.checksum_sha256,

    status:
      runStatus ===
      "rejected"
        ? "rejected"
        : row.status,

    createdByUserId:
      row.created_by_user_id,

    createdAt:
      row.created_at,
  };
}

function mapIngestionRun(row) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    dataSourceId:
      row.data_source_id,

    dataStreamId:
      row.data_stream_id,

    reportingPeriodId:
      row.reporting_period_id,

    rawDataObjectId:
      row.raw_data_object_id,

    schemaVersionId:
      row.schema_version_id,

    status:
      row.status,

    schemaDrift:
      row.schema_drift,

    rowCount:
      Number(
        row.row_count ??
        0,
      ),

    columnCount:
      Number(
        row.column_count ??
        0,
      ),

    createdByUserId:
      row.created_by_user_id,

    createdAt:
      row.created_at,
  };
}

function mapSchemaVersion(row) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    dataStreamId:
      row.data_stream_id,

    version:
      Number(
        row.version,
      ),

    schemaFingerprint:
      row.schema_fingerprint,

    columns:
      row.columns,

    createdByUserId:
      row.created_by_user_id,

    createdAt:
      row.created_at,
  };
}

function mapValidationResult(
  row,
) {
  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    ingestionRunId:
      row.ingestion_run_id,

    severity:
      row.severity,

    code:
      row.code,

    message:
      row.message,

    createdAt:
      row.created_at,
  };
}

function clean(value) {
  return String(
    value ?? "",
  ).trim();
}