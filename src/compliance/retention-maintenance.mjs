import { withTransaction } from "../database/postgres.mjs";

export const RETENTION_TARGETS = Object.freeze({ deletionDays: 30, backupDays: 30, operationalLogDays: 90 });
const DAY_MS = 86_400_000;

// This operator-only job does not inherit the web runtime's tenant context.
// A global report through an RLS-filtered role could falsely report no records.
async function requireMaintenanceRole(client) {
  const result = await client.query("select rolsuper or rolbypassrls as authorized from pg_roles where rolname = current_user");
  if (result.rows[0]?.authorized !== true) throw Object.assign(new Error("Use a separately approved privileged maintenance connection, not the application role."), { code: "RETENTION_ROLE_REQUIRED" });
}

export async function runRetentionMaintenance({ pool, now = new Date(), apply = false, batchSize = 500 } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof apply !== "boolean" || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new TypeError("Retention maintenance needs a valid date, explicit boolean mode and batch size from 1 to 5000.");
  }
  const credentialCutoff = new Date(now.getTime() - RETENTION_TARGETS.operationalLogDays * DAY_MS);
  const deletionCutoff = new Date(now.getTime() - RETENTION_TARGETS.deletionDays * DAY_MS);
  return withTransaction(pool, async client => {
    if (!apply) await client.query("set transaction read only");
    await requireMaintenanceRole(client);
    await client.query("set local statement_timeout = '30s'");
    const candidates = await client.query(`select
      (select count(*)::integer from user_sessions where created_at < $1 and (expires_at <= $2 or revoked_at <= $2)) as sessions,
      (select count(*)::integer from email_verification_challenges where created_at < $1 and expires_at <= $2) as challenges`, [credentialCutoff, now]);
    let removed = { sessions: 0, challenges: 0 };
    if (apply) {
      const sessions = await client.query(`with expired as (
        select id from user_sessions where created_at < $1 and (expires_at <= $2 or revoked_at <= $2)
        order by created_at, id limit $3 for update skip locked)
        delete from user_sessions where id in (select id from expired) returning id`, [credentialCutoff, now, batchSize]);
      const challenges = await client.query(`with expired as (
        select id from email_verification_challenges where created_at < $1 and expires_at <= $2
        order by created_at, id limit $3 for update skip locked)
        delete from email_verification_challenges where id in (select id from expired) returning id`, [credentialCutoff, now, batchSize]);
      removed = { sessions: sessions.rowCount, challenges: challenges.rowCount };
    }
    const deadlines = await client.query(`select count(*)::integer as outstanding,
      count(*) filter (where requested_at <= $1)::integer as overdue,
      count(*) filter (where status = 'attention')::integer as attention
      from account_deletion_requests where status <> 'completed'`, [deletionCutoff]);
    return { mode: apply ? "apply" : "dry-run", checkedAt: now.toISOString(), credentialCutoff: credentialCutoff.toISOString(),
      candidates: candidates.rows[0], removed, deletion: { targetDays: RETENTION_TARGETS.deletionDays, ...deadlines.rows[0] },
      infrastructure: "unverified", financialRecords: "not modified", auditEvidence: "not modified" };
  });
}
