import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "../database/postgres.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function requireWriter(client, organizationId, actorUserId) {
  const member = await client.query(
    `select role from organization_memberships
     where organization_id = $1 and user_id = $2
       and status = 'active'
     limit 1`,
    [organizationId, actorUserId],
  );

  const role = member.rows[0]?.role;

  if (role !== "owner" && role !== "admin") {
    throw new AuthError(
      "Only organization owners and administrators can permanently delete source files.",
      "CAPABILITY_DENIED",
    );
  }
  if (!(ROLE_CAPABILITIES[role] ?? []).includes(
    CAPABILITIES.WRITE_BUSINESS_DATA
  )) {
    throw new AuthError(
      "Business write permission required.",
      "CAPABILITY_DENIED",
    );
  }
}

function storageKeyAllowed(organizationId, key) {
  return [
    `organizations/${organizationId}/uploads/`,
    `org/${organizationId}/raw/`,
  ].some(prefix => String(key).startsWith(prefix));
}

const DEPENDENCIES = [
  ["verified_metric_runs", "ingestion_run_id = $2"],
  ["verified_metric_points",
    "ingestion_run_id = $2 or raw_data_object_id = $3"],
  ["ingestion_import_manifests",
    "ingestion_run_id = $2 or supersedes_run_id = $2 or original_raw_object_id = $3"],
  ["money_trail_imports", "ingestion_run_id = $2"],
  ["money_trail_records",
    "ingestion_run_id = $2 or raw_data_object_id = $3"],
  ["money_trail_source_supersessions",
    "previous_ingestion_run_id = $2 or new_ingestion_run_id = $2"],
  ["manual_entry_deliveries", "ingestion_run_id = $2"],
  ["notification_events", "ingestion_run_id = $2"],
];

async function requireNoDerivedDependencies(client, source, organizationId) {
  for (const [table, condition] of DEPENDENCIES) {
    const exists = await client.query(
      "select to_regclass($1) as relation",
      [`public.${table}`],
    );

    if (!exists.rows[0]?.relation) continue;

    const args = condition.includes("$3")
      ? [organizationId, source.id, source.raw_data_object_id]
      : [organizationId, source.id];

    // Table and condition are fixed application constants,
    // never supplied by the browser.
    const result = await client.query(
      `select 1 from ${table}
       where organization_id = $1 and (${condition})
       limit 1`,
      args,
    );

    if (result.rowCount) {
      throw new AuthError(
        "This file has dependent business records. Delete is blocked to protect reports and financial history.",
        "CONFLICT",
      );
    }
  }

  if (source.status !== "rejected") {
    const closed = await client.query(
      "select to_regclass('public.monthly_close_versions') as relation",
    );

    if (closed.rows[0]?.relation) {
      const result = await client.query(
        `select 1 from monthly_close_versions
         where organization_id = $1 and period = $2
         limit 1`,
        [organizationId, source.period_month],
      );

      if (result.rowCount) {
        throw new AuthError(
          "This reporting month has a protected monthly close.",
          "CONFLICT",
        );
      }
    }

    const sets = await client.query(
      "select to_regclass('public.monthly_required_sources') as relation",
    );

    if (sets.rows[0]?.relation) {
      const result = await client.query(
        `select 1
         from monthly_required_sources r
         join monthly_source_sets s
           on s.organization_id = r.organization_id
          and s.id = r.source_set_id
         where r.organization_id = $1
           and r.data_stream_id = $2
           and s.period = $3
         limit 1`,
        [organizationId, source.data_stream_id, source.period_month],
      );

      if (result.rowCount) {
        throw new AuthError(
          "This source belongs to protected monthly review history.",
          "CONFLICT",
        );
      }
    }
  }
}

export class SourceFileDeletionService {
  constructor({ pool, objectStorage }) {
    if (!pool || !objectStorage) {
      throw new TypeError(
        "Database and object storage are required.",
      );
    }

    this.pool = pool;
    this.objectStorage = objectStorage;
  }

  async delete({ organizationId, actorUserId, uploadId }) {
    if (!UUID.test(String(uploadId ?? ""))) {
      throw new AuthError(
        "Invalid source identifier.", "VALIDATION_FAILED",
      );
    }

    try {
      return await withTenantTransaction(
        this.pool,
        { organizationId, actorUserId },
        async client => {
          await requireWriter(client, organizationId, actorUserId);

          const preliminary = await client.query(
            `select r.storage_key
             from ingestion_runs ir
             join raw_data_objects r
               on r.id = ir.raw_data_object_id
              and r.organization_id = ir.organization_id
             where ir.organization_id = $1 and ir.id = $2`,
            [organizationId, uploadId],
          );

          if (!preliminary.rows[0]) {
            throw new AuthError(
              "Source not found.", "NOT_FOUND",
            );
          }

          const key = preliminary.rows[0].storage_key;

          await client.query(
            `select pg_advisory_xact_lock(
               hashtextextended($1, 0)
             )`,
            [`${organizationId}:${key}`],
          );

          const locked = await client.query(
            `select ir.id, ir.status, ir.manual_submission_id,
                    ir.raw_data_object_id, ir.data_stream_id,
                    to_char(rp.period_start, 'YYYY-MM') as period_month,
                    r.storage_key
             from ingestion_runs ir
             join raw_data_objects r
               on r.id = ir.raw_data_object_id
              and r.organization_id = ir.organization_id
             join reporting_periods rp
               on rp.id = ir.reporting_period_id
              and rp.organization_id = ir.organization_id
             where ir.organization_id = $1 and ir.id = $2
             for update of ir, r`,
            [organizationId, uploadId],
          );

          const source = locked.rows[0];

          if (!source) {
            throw new AuthError(
              "Source not found.", "NOT_FOUND",
            );
          }

          if (!["rejected", "validated"].includes(source.status)) {
            throw new AuthError(
              "This source cannot be deleted in its current state.",
              "CONFLICT",
            );
          }

          if (source.manual_submission_id) {
            throw new AuthError(
              "Manual-entry snapshots require the correction workflow.",
              "CONFLICT",
            );
          }

          if (!storageKeyAllowed(organizationId, source.storage_key)) {
            throw new AuthError(
              "Source storage ownership could not be verified.",
              "CONFLICT",
            );
          }

          const shared = await client.query(
            `select 1 from ingestion_runs
             where organization_id = $1
               and raw_data_object_id = $2
               and id <> $3
             limit 1`,
            [organizationId, source.raw_data_object_id, uploadId],
          );

          if (shared.rowCount) {
            throw new AuthError(
              "This object is referenced by another upload.",
              "CONFLICT",
            );
          }

          await requireNoDerivedDependencies(
            client, source, organizationId,
          );

          // Lock queued processing jobs to prevent worker races.
          const jobs = await client.query(
            `select id, status from processing_jobs
             where organization_id = $1
               and ingestion_run_id = $2
             for share`,
            [organizationId, uploadId],
          );

          if (jobs.rows.some(job => job.status !== "queued")) {
            throw new AuthError(
              "This source has already entered processing. Deletion is blocked.",
              "CONFLICT",
            );
          }

          // Retain a durable record of pending storage cleanup.
          const queued = await client.query(
            `insert into source_file_deletion_outbox
               (organization_id, upload_id, storage_key,
                requested_by_user_id)
             values ($1, $2, $3, $4)
             returning id`,
            [
              organizationId, uploadId,
              source.storage_key, actorUserId,
            ],
          );

          await client.query(
            `delete from processing_jobs
             where organization_id = $1
               and ingestion_run_id = $2
               and status = 'queued'`,
            [organizationId, uploadId],
          );

          await client.query(
            `delete from ingestion_validation_results
             where organization_id = $1
               and ingestion_run_id = $2`,
            [organizationId, uploadId],
          );

          await client.query(
            `delete from ingestion_runs
             where organization_id = $1 and id = $2`,
            [organizationId, uploadId],
          );

          await client.query(
            `delete from raw_data_objects
             where organization_id = $1 and id = $2`,
            [organizationId, source.raw_data_object_id],
          );

          await client.query(
            `insert into audit_events
               (organization_id, actor_user_id,
                event_type, target_type, target_id)
             values ($1, $2, $3, $4, $5)`,
            [
              organizationId, actorUserId,
              "ingestion.source_deleted",
              "ingestion_run", uploadId,
            ],
          );

          return {
            deletedFromDatabase: true,
            outboxId: queued.rows[0].id,
          };
        },
      );
    } catch (error) {
      if (["23503", "23514"].includes(error.code)) {
        throw new AuthError(
          "Deletion is blocked by a protected data dependency. No database records were removed.",
          "CONFLICT",
        );
      }

      throw error;
    }
  }

  async flushPending({
    organizationId, actorUserId, onlyId = null,
  }) {
    const context = { organizationId, actorUserId };

    const pending = await withTenantTransaction(
      this.pool,
      context,
      async client => {
        await requireWriter(client, organizationId, actorUserId);

        return (await client.query(
          `select id, storage_key
           from source_file_deletion_outbox
           where organization_id = $1
             and completed_at is null
             and ($2::uuid is null or id = $2)
           order by requested_at
           limit 5`,
          [organizationId, onlyId],
        )).rows;
      },
    );

    const completed = [];
    const stillPending = [];

    for (const item of pending) {
      let success = false;

      try {
        if (!storageKeyAllowed(organizationId, item.storage_key)) {
          throw new Error("Invalid tenant storage key.");
        }

        await this.objectStorage.deleteObject({
          key: item.storage_key,
        });

        success = true;
      } catch {
        // Preserve the outbox entry for another attempt.
      }

      await withTenantTransaction(
        this.pool,
        context,
        async client => {
          await requireWriter(client, organizationId, actorUserId);

          await client.query(
            `update source_file_deletion_outbox
             set attempts = attempts + 1,
                 last_attempt_at = now(),
                 completed_at = case
                   when $3 then now()
                   else completed_at
                 end
             where organization_id = $1
               and id = $2
               and completed_at is null`,
            [organizationId, item.id, success],
          );
        },
      );

      (success ? completed : stillPending).push(item.id);
    }

    return { completed, stillPending };
  }
}