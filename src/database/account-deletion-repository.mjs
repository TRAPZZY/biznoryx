import { randomBytes } from "node:crypto";
import { AuthError, hashSecret, verifyPassword } from "../auth/core.mjs";
import { withTransaction } from "./postgres.mjs";

export class PostgresAccountDeletionRepository {
  constructor(pool) { this.pool = pool; }

  async context(userId) {
    return withTransaction(this.pool, async (client) => {
      await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
      const result = await client.query("select runtime_account_deletion_context($1) as context", [userId]);
      return result.rows[0].context;
    });
  }

  async request({ userId, password, transfers = {}, closeWorkspaces = false, confirm = false }) {
    if (confirm !== true || typeof password !== "string" || password.length > 1024 ||
        !transfers || Array.isArray(transfers) || typeof transfers !== "object") {
      throw new AuthError("Confirm deletion and enter your current password.", "VALIDATION_FAILED");
    }
    const receipt = randomBytes(32).toString("base64url");
    await withTransaction(this.pool, async (client) => {
      await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
      const result = await client.query("select password_hash, disabled_at from app_users where id = $1 for update", [userId]);
      const user = result.rows[0];
      if (!user || user.disabled_at || !verifyPassword(password, user.password_hash)) {
        throw new AuthError("Your current password is incorrect.", "INVALID_CREDENTIALS");
      }
      try {
        await client.query("select runtime_request_account_deletion($1,$2,$3,$4)",
          [userId, hashSecret(receipt), transfers, closeWorkspaces === true]);
      } catch (error) {
        if (error.code === "23514") throw new AuthError("Transfer ownership or confirm closure of your remaining workspaces.", "VALIDATION_FAILED");
        if (["42501", "22P02"].includes(error.code)) throw new AuthError("The selected replacement owner is unavailable.", "VALIDATION_FAILED");
        throw error;
      }
    });
    return { requested: true, receipt, status: "queued" };
  }

  async status(receipt) {
    if (typeof receipt !== "string" || !/^[\w-]{43}$/.test(receipt)) throw new AuthError("Enter a valid deletion reference.", "VALIDATION_FAILED");
    const result = await this.pool.query("select runtime_account_deletion_status($1) as status", [hashSecret(receipt)]);
    if (!result.rows[0]?.status) throw new AuthError("Deletion request was not found.", "NOT_FOUND");
    return result.rows[0].status;
  }

  async pending() {
    const result = await this.pool.query("select pending.* from runtime_pending_account_deletions() pending");
    return result.rows;
  }

  async withLock(job, work) {
    const client = await this.pool.connect();
    const key = `account-deletion:${job.id}`;
    let locked = false;
    try {
      locked = (await client.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [key])).rows[0].locked;
      if (!locked) return;
      // Resolve the fresh job under the lock; another worker may have completed it.
      const fresh = (await client.query("select pending.* from runtime_pending_account_deletions() pending where id = $1", [job.id])).rows[0];
      if (!fresh) return;
      await work(fresh);
    } finally {
      let broken = false;
      if (locked) {
        try { await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]); }
        catch { broken = true; }
      }
      client.release(broken);
    }
  }

  async finish(id) { await this.pool.query("select runtime_finish_account_deletion($1)", [id]); }
  async retry(id, code) { await this.pool.query("select runtime_account_deletion_retry($1,$2)", [id, code]); }
}
