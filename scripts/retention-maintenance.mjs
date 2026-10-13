import { createPostgresPool } from "../src/database/postgres.mjs";
import { runRetentionMaintenance } from "../src/compliance/retention-maintenance.mjs";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply") || args.length > 1) throw new Error("Use no arguments for a dry run, or --apply for approved expired-credential cleanup.");
const pool = createPostgresPool();
try {
  const result = await runRetentionMaintenance({ pool, apply: args.includes("--apply") });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.deletion.overdue || result.deletion.attention) process.exitCode = 2;
} catch (error) {
  // Do not print connection strings, SQL parameters or record identifiers.
  process.stderr.write(`Retention maintenance failed: ${String(error.code ?? "RETENTION_FAILED").replace(/[^A-Z0-9_]/gi, "").slice(0, 80)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
