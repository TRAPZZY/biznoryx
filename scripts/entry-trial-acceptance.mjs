import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Only local Docker PostgreSQL is used; every test database is disposable.
const database = `biznoryx_entry_test_${randomBytes(6).toString("hex")}`;
const psql = ["compose", "exec", "-T", "postgres", "psql", "-U", "biznoryx_admin"];
const password = process.env.BIZNORYX_APP_DB_PASSWORD;
if (!password) throw new Error("Load .env.local with BIZNORYX_APP_DB_PASSWORD before running acceptance.");
function run(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || "Local database command failed.");
  return result.stdout.trim();
}
let created = false;
try {
  const adminPassword = run(["compose", "exec", "-T", "postgres", "printenv", "POSTGRES_PASSWORD"]);
  run([...psql, "-d", "postgres", "-c", `create database ${database}`]);
  created = true;
  for (const directory of ["db/migrations", "db/bootstrap"]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql")).sort()) {
      run([...psql, "-d", database, "-v", "ON_ERROR_STOP=1", "-v", `biznoryx_app_password=${password}`, "-f", "-"], {
        input: readFileSync(`${directory}/${file}`),
      });
    }
  }
  const url = new URL("postgresql://biznoryx_admin@127.0.0.1:5432/postgres");
  url.password = adminPassword;
  const adminUrl = url.href;
  url.pathname = `/${database}`;
  const result = spawnSync(process.execPath, ["--test", "tests/postgres-manual-entry.test.mjs", "tests/billing-trial-postgres.test.mjs"], {
    stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url.href, TRIAL_TEST_ADMIN_DATABASE_URL: adminUrl },
  });
  if (result.status !== 0) throw new Error("Entry/trial database acceptance failed.");
} finally {
  if (created) run([...psql, "-d", "postgres", "-c", `drop database ${database} with (force)`]);
}
