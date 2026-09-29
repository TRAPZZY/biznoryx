export class PostgresProcessingJobRepository {
  constructor(pool) {
    if (!pool) {
      throw new TypeError(
        "PostgreSQL pool is required.",
      );
    }

    this.pool = pool;
  }

  async heartbeat({
    workerId,
    status = "ready",
    metadata = {},
  }) {
    validateWorkerId(
      workerId,
    );

    if (
      ![
        "ready",
        "busy",
        "stopping",
        "stopped",
      ].includes(status)
    ) {
      throw new WorkerJobError(
        "Worker heartbeat status is invalid.",
        "WORKER_STATUS_INVALID",
      );
    }

    const result =
      await this.pool.query(
        `insert into worker_heartbeats (
           worker_id,
           status,
           started_at,
           last_seen_at,
           metadata
         )
         values (
           $1,
           $2,
           now(),
           now(),
           $3::jsonb
         )
         on conflict (worker_id)
         do update set
           status = excluded.status,
           last_seen_at = now(),
           metadata = excluded.metadata
         returning
           worker_id,
           status,
           started_at,
           last_seen_at,
           metadata`,
        [
          workerId,
          status,
          JSON.stringify(
            metadata,
          ),
        ],
      );

    return mapHeartbeat(
      result.rows[0],
    );
  }

  async hasHealthyWorker({
    maxAgeSeconds = 30,
  } = {}) {
    if (
      !Number.isInteger(
        maxAgeSeconds,
      ) ||
      maxAgeSeconds < 5 ||
      maxAgeSeconds > 300
    ) {
      throw new WorkerJobError(
        "Worker heartbeat age is invalid.",
        "WORKER_HEALTH_CONFIGURATION_INVALID",
      );
    }

    const result =
      await this.pool.query(
        `select exists (
           select 1
           from worker_heartbeats
           where status in (
             'ready',
             'busy'
           )
             and last_seen_at >=
               now() -
               ($1::integer * interval '1 second')
         ) as healthy`,
        [
          maxAgeSeconds,
        ],
      );

    return Boolean(
      result.rows[0]?.healthy,
    );
  }

  async leaseNext({
    workerId,
    leaseSeconds = 60,
  }) {
    validateWorkerId(
      workerId,
    );

    if (
      !Number.isInteger(
        leaseSeconds,
      ) ||
      leaseSeconds < 10 ||
      leaseSeconds > 900
    ) {
      throw new WorkerJobError(
        "Worker lease duration is invalid.",
        "WORKER_LEASE_INVALID",
      );
    }

    const client =
      await this.pool.connect();

    try {
      await client.query(
        "begin",
      );

      await client.query(
        `update processing_jobs
         set
           status =
             case
               when attempts >= max_attempts
                 then 'dead'
               else 'queued'
             end,

           leased_by = null,
           leased_at = null,
           lease_expires_at = null,

           available_at =
             case
               when attempts >= max_attempts
                 then available_at
               else now()
             end,

           last_error =
             case
               when attempts >= max_attempts
                 then coalesce(
                   last_error,
                   'Worker lease expired.'
                 )
               else last_error
             end,

           updated_at = now()

         where status = 'leased'
           and lease_expires_at <= now()`,
      );

      const selected =
        await client.query(
          `select
             id,
             organization_id,
             ingestion_run_id,
             job_type,
             status,
             payload,
             idempotency_key,
             priority,
             attempts,
             max_attempts,
             available_at,
             leased_at,
             lease_expires_at,
             leased_by,
             last_error,
             completed_at,
             created_at,
             updated_at
           from processing_jobs
           where status in (
             'queued',
             'failed'
           )
             and available_at <= now()
             and attempts < max_attempts
           order by
             priority asc,
             created_at asc
           for update skip locked
           limit 1`,
        );

      const row =
        selected.rows[0];

      if (!row) {
        await client.query(
          "commit",
        );

        return null;
      }

      const leased =
        await client.query(
          `update processing_jobs
           set
             status = 'leased',
             attempts = attempts + 1,
             leased_by = $2,
             leased_at = now(),
             lease_expires_at =
               now() +
               ($3::integer * interval '1 second'),
             updated_at = now()
           where id = $1
           returning
             id,
             organization_id,
             ingestion_run_id,
             job_type,
             status,
             payload,
             idempotency_key,
             priority,
             attempts,
             max_attempts,
             available_at,
             leased_at,
             lease_expires_at,
             leased_by,
             last_error,
             completed_at,
             created_at,
             updated_at`,
          [
            row.id,
            workerId,
            leaseSeconds,
          ],
        );

      await client.query(
        "commit",
      );

      return mapJob(
        leased.rows[0],
      );
    } catch (error) {
      await safeRollback(
        client,
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async complete({
    jobId,
    workerId,
  }) {
    validateWorkerId(
      workerId,
    );

    const result =
      await this.pool.query(
        `update processing_jobs
         set
           status = 'succeeded',
           completed_at = now(),
           leased_by = null,
           leased_at = null,
           lease_expires_at = null,
           last_error = null,
           updated_at = now()
         where id = $1
           and status = 'leased'
           and leased_by = $2
         returning
           id,
           organization_id,
           ingestion_run_id,
           job_type,
           status,
           payload,
           idempotency_key,
           priority,
           attempts,
           max_attempts,
           available_at,
           leased_at,
           lease_expires_at,
           leased_by,
           last_error,
           completed_at,
           created_at,
           updated_at`,
        [
          jobId,
          workerId,
        ],
      );

    if (
      !result.rows[0]
    ) {
      throw new WorkerJobError(
        "Worker does not own this job lease.",
        "WORKER_LEASE_LOST",
      );
    }

    return mapJob(
      result.rows[0],
    );
  }

  async fail({
    jobId,
    workerId,
    error,
  }) {
    validateWorkerId(
      workerId,
    );

    const client =
      await this.pool.connect();

    try {
      await client.query(
        "begin",
      );

      const current =
        await client.query(
          `select
             id,
             attempts,
             max_attempts
           from processing_jobs
           where id = $1
             and status = 'leased'
             and leased_by = $2
           for update`,
          [
            jobId,
            workerId,
          ],
        );

      const job =
        current.rows[0];

      if (!job) {
        throw new WorkerJobError(
          "Worker does not own this job lease.",
          "WORKER_LEASE_LOST",
        );
      }

      const attempts =
        Number(
          job.attempts,
        );

      const maxAttempts =
        Number(
          job.max_attempts,
        );

      const dead =
        attempts >=
        maxAttempts;

      const retrySeconds =
        Math.min(
          3600,
          30 *
            2 **
              Math.max(
                0,
                attempts - 1,
              ),
        );

      const availableAt =
        new Date(
          Date.now() +
            retrySeconds *
              1000,
        );

      const failed =
        await client.query(
          `update processing_jobs
           set
             status = $3,

             available_at =
               case
                 when $3 = 'dead'
                   then available_at
                 else $4
               end,

             leased_by = null,
             leased_at = null,
             lease_expires_at = null,
             last_error = $5,
             updated_at = now()

           where id = $1
             and status = 'leased'
             and leased_by = $2

           returning
             id,
             organization_id,
             ingestion_run_id,
             job_type,
             status,
             payload,
             idempotency_key,
             priority,
             attempts,
             max_attempts,
             available_at,
             leased_at,
             lease_expires_at,
             leased_by,
             last_error,
             completed_at,
             created_at,
             updated_at`,
          [
            jobId,
            workerId,

            dead
              ? "dead"
              : "failed",

            availableAt,

            safeErrorMessage(
              error,
            ),
          ],
        );

      await client.query(
        "commit",
      );

      return mapJob(
        failed.rows[0],
      );
    } catch (failure) {
      await safeRollback(
        client,
      );

      throw failure;
    } finally {
      client.release();
    }
  }

  async getIngestionContext({
    job,
  }) {
    if (
      !job ||
      !job.organizationId ||
      !job.ingestionRunId
    ) {
      throw new WorkerJobError(
        "Ingestion job context is incomplete.",
        "INGESTION_CONTEXT_MISSING",
      );
    }

    const client =
      await this.pool.connect();

    try {
      await client.query(
        "begin",
      );

      await client.query(
        `select set_config(
           'app.current_organization_id',
           $1,
           true
         )`,
        [
          job.organizationId,
        ],
      );

      const result =
        await client.query(
          `select
             ir.id as ingestion_run_id,
             ir.organization_id,
             ir.status as ingestion_status,
             ir.raw_data_object_id,

             rdo.storage_key,
             rdo.original_filename,
             rdo.content_type,
             rdo.byte_size,
             rdo.checksum_sha256,
             rdo.status as raw_object_status

           from ingestion_runs ir

           join raw_data_objects rdo
             on rdo.id =
               ir.raw_data_object_id

           where ir.id = $1
             and ir.organization_id = $2

           limit 1`,
          [
            job.ingestionRunId,
            job.organizationId,
          ],
        );

      await client.query(
        "commit",
      );

      const row =
        result.rows[0];

      if (!row) {
        throw new WorkerJobError(
          "Ingestion run was not found.",
          "INGESTION_CONTEXT_MISSING",
        );
      }

      return {
        ingestionRunId:
          row.ingestion_run_id,

        organizationId:
          row.organization_id,

        ingestionStatus:
          row.ingestion_status,

        rawObject: {
          id:
            row.raw_data_object_id,

          storageKey:
            row.storage_key,

          originalFilename:
            row.original_filename,

          contentType:
            row.content_type,

          byteSize:
            Number(
              row.byte_size,
            ),

          checksumSha256:
            row.checksum_sha256,

          status:
            row.raw_object_status,
        },
      };
    } catch (error) {
      await safeRollback(
        client,
      );

      throw error;
    } finally {
      client.release();
    }
  }

  async queueHealth() {
    const result =
      await this.pool.query(
        `select
           count(*) filter (
             where status = 'queued'
           )::integer as queued,

           count(*) filter (
             where status = 'leased'
           )::integer as leased,

           count(*) filter (
             where status = 'failed'
           )::integer as failed,

           count(*) filter (
             where status = 'dead'
           )::integer as dead

         from processing_jobs`,
      );

    const row =
      result.rows[0] ?? {};

    return {
      queued:
        Number(
          row.queued ?? 0,
        ),

      leased:
        Number(
          row.leased ?? 0,
        ),

      failed:
        Number(
          row.failed ?? 0,
        ),

      dead:
        Number(
          row.dead ?? 0,
        ),
    };
  }
}

export class WorkerJobError
  extends Error {
  constructor(
    message,
    code =
      "WORKER_JOB_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "WorkerJobError";

    this.code =
      code;
  }
}

function mapJob(row) {
  if (!row) {
    return null;
  }

  return {
    id:
      row.id,

    organizationId:
      row.organization_id,

    ingestionRunId:
      row.ingestion_run_id,

    jobType:
      row.job_type,

    status:
      row.status,

    payload:
      row.payload ?? {},

    idempotencyKey:
      row.idempotency_key,

    priority:
      Number(
        row.priority,
      ),

    attempts:
      Number(
        row.attempts,
      ),

    maxAttempts:
      Number(
        row.max_attempts,
      ),

    availableAt:
      row.available_at,

    leasedAt:
      row.leased_at,

    leaseExpiresAt:
      row.lease_expires_at,

    leasedBy:
      row.leased_by,

    lastError:
      row.last_error,

    completedAt:
      row.completed_at,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function mapHeartbeat(row) {
  return {
    workerId:
      row.worker_id,

    status:
      row.status,

    startedAt:
      row.started_at,

    lastSeenAt:
      row.last_seen_at,

    metadata:
      row.metadata ?? {},
  };
}

function validateWorkerId(
  workerId,
) {
  if (
    typeof workerId !==
      "string" ||
    !workerId.trim() ||
    workerId.length > 200
  ) {
    throw new WorkerJobError(
      "Worker ID is invalid.",
      "WORKER_ID_INVALID",
    );
  }
}

function safeErrorMessage(
  error,
) {
  const name =
    String(
      error?.name ??
        "Error",
    )
      .replace(
        /[^a-zA-Z0-9_.-]/g,
        "",
      )
      .slice(
        0,
        80,
      ) || "Error";

  const message =
    String(
      error?.message ??
        "Worker job failed.",
    )
      .replace(
        /[\r\n\t]+/g,
        " ",
      )
      .replace(
        /(password|secret|token|api[-_ ]?key)\s*[:=]\s*\S+/gi,
        "$1=[redacted]",
      )
      .slice(
        0,
        1800,
      );

  return `${name}: ${message}`;
}

async function safeRollback(
  client,
) {
  try {
    await client.query(
      "rollback",
    );
  } catch {
    // Preserve original failure.
  }
}