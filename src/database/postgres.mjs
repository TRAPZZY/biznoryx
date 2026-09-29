import pg from "pg";

import { AuthError } from "../auth/core.mjs";

const { Pool } = pg;

export function createPostgresPool(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the durable application runtime.");
  }

  const production = env.NODE_ENV === "production";
  const ssl = production
    ? {
        rejectUnauthorized: true,
      }
    : undefined;

  const pool = new Pool({
    connectionString,
    ssl,
    max: positiveInteger(env.BIZNORYX_DB_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInteger(
      env.BIZNORYX_DB_CONNECT_TIMEOUT_MS,
      5000,
    ),
    idleTimeoutMillis: positiveInteger(env.BIZNORYX_DB_IDLE_TIMEOUT_MS, 30000),
    application_name: "biznoryx-web",
  });

  pool.on("error", (error) => {
    process.stderr.write(`Unexpected PostgreSQL pool error: ${error.message}\n`);
  });
  return pool;
}

export async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenantTransaction(
  pool,
  { organizationId, actorUserId },
  work,
) {
  if (!organizationId || !actorUserId) {
    throw new AuthError(
      "Organization and actor are required for tenant transactions.",
      "TENANT_CONTEXT_REQUIRED",
    );
  }
  return withTransaction(pool, async (client) => {
    await client.query(
      "select set_config('app.current_organization_id', $1, true)",
      [organizationId],
    );
    await client.query("select set_config('app.current_user_id', $1, true)", [
      actorUserId,
    ]);
    return work(client);
  });
}

export async function checkDatabaseHealth(pool) {
  const result = await pool.query(
    "select current_database() as database, current_user as role, now() as checked_at",
  );
  return result.rows[0];
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Database pool settings must be positive integers.");
  }
  return parsed;
}
