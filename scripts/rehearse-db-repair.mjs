import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import pg from "pg";

const referenceDatabase = "biznoryx_repair_reference_20261022";
const repairFiles = [
  "0025_billing_payment_history.sql",
  "0027_disabled_organization_sessions.sql",
  "0028_billing_provider_identity.sql",
  "0029_account_audit_self_access.sql",
  "0033_in_app_updates.sql",
];
let stage = "configuration";
let pool;
let client;
let transaction = false;

function log(message) {
  process.stdout.write(`${message}\n`);
}

export function assertForkEnvironment(env) {
  assert.equal(env.BIZNORYX_REHEARSAL_CONFIRM, "isolated-fork-only");
  assert.match(env.NF_BIZNORYX_DB_REPAIR_HOST ?? "", /biznoryx-db-repair/);
  for (const key of ["PORT", "DATABASE", "ADMIN_USERNAME", "ADMIN_PASSWORD"]) {
    assert.ok(env[`NF_BIZNORYX_DB_REPAIR_${key}`]);
  }
  assert.notEqual(env.NF_BIZNORYX_DB_REPAIR_DATABASE, referenceDatabase);
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (
      /^NF_BIZNORYX_DB_REPAIR_(HOST|PORT|DATABASE|ADMIN_USERNAME|ADMIN_PASSWORD)$/.test(
        key,
      )
    )
      continue;
    if (key === "PGPASSWORD") {
      assert.equal(value, env.NF_BIZNORYX_DB_REPAIR_ADMIN_PASSWORD);
      continue;
    }
    assert.ok(
      !/^NF_BIZNORYX_DB_/.test(key) &&
        !/(^|_)(DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|PASSWORD|SECRET|API_KEY|ACCESS_KEY|ENCRYPTION_KEY|TOKEN)(_|$)/.test(
          key,
        ),
      "Unrelated credential environment must not be present",
    );
  }
}

export function unwrapTransaction(sql) {
  const trimmed = sql.trim();
  assert.match(trimmed, /^begin;\s/i);
  assert.match(trimmed, /\scommit;$/i);
  return trimmed.slice(6, -7);
}

function comparable(record) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !["scope", "owner"].includes(key))
      .map(([key, value]) => [
        key,
        key.endsWith("_md5") ? value.trim() : value,
      ]),
  );
}

function objectKey(record) {
  return `${record.probe}:${record.name}:${record.args ?? ""}`;
}

async function signatures(connection, scope, insideTransaction = false) {
  let sql = readFileSync("db/diagnostics/schema-fingerprints.sql", "utf8")
    .replace("\\set ON_ERROR_STOP on", "")
    .replaceAll(":'probe_scope'", `'${scope}'`);
  if (insideTransaction) {
    sql = sql.replace("begin read only;", "").replace(/rollback;\s*$/, "");
  }
  const results = await connection.query(sql);
  return results
    .flatMap((result) => result.rows ?? [])
    .map((row) => row.jsonb_build_object);
}

export function checkSignatures(
  expected,
  actual,
  { allowAdditional = false } = {},
) {
  const actualMap = new Map(
    actual.map((row) => [objectKey(row), comparable(row)]),
  );
  assert.equal(
    actualMap.size,
    actual.length,
    "Duplicate schema object signatures",
  );
  if (!allowAdditional) {
    assert.equal(actual.length, expected.length, "Unexpected schema objects");
  }
  for (const row of expected) {
    assert.deepEqual(
      actualMap.get(objectKey(row)),
      comparable(row),
      `Schema differs: ${objectKey(row)}`,
    );
  }
}

function urlFor(database, role) {
  const url = new URL("postgresql://localhost/");
  url.hostname = process.env.NF_BIZNORYX_DB_REPAIR_HOST;
  url.port = process.env.NF_BIZNORYX_DB_REPAIR_PORT;
  url.username = process.env.NF_BIZNORYX_DB_REPAIR_ADMIN_USERNAME;
  url.password = process.env.NF_BIZNORYX_DB_REPAIR_ADMIN_PASSWORD;
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "verify-full");
  if (role) {
    assert.match(role, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
    url.searchParams.set("options", `-c role=${role}`);
  }
  return url.href;
}

function runTests(label, files, env) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180000,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`/tmp/rehearsal-${label}.log`, output, { mode: 0o600 });
  for (const line of output
    .split("\n")
    .filter((line) => /^# (tests|pass|fail|skipped) \d+$/.test(line))) {
    log(`${label}: ${line}`);
  }
  if (result.status !== 0 || result.error) {
    for (const line of output
      .split("\n")
      .filter((line) => /^not ok \d+ - /.test(line)))
      log(line);
    throw new Error(`Test phase failed: ${label}`);
  }
}

async function main() {
  assertForkEnvironment(process.env);
  pool = new pg.Pool({
    host: process.env.NF_BIZNORYX_DB_REPAIR_HOST,
    port: Number(process.env.NF_BIZNORYX_DB_REPAIR_PORT),
    database: process.env.NF_BIZNORYX_DB_REPAIR_DATABASE,
    user: process.env.NF_BIZNORYX_DB_REPAIR_ADMIN_USERNAME,
    password: process.env.NF_BIZNORYX_DB_REPAIR_ADMIN_PASSWORD,
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10000,
    application_name: "biznoryx-isolated-repair",
  });
  client = await pool.connect();
  stage = "baseline";
  const baseline = JSON.parse(
    readFileSync(".rehearsal-baseline.json", "utf8"),
  ).filter((r) => r.scope === "restored");
  assert.ok(baseline.length > 20);
  checkSignatures(baseline, await signatures(client, "restored"), {
    allowAdditional: true,
  });
  const reference = new pg.Client({
    connectionString: urlFor(referenceDatabase),
    ssl: { rejectUnauthorized: true },
  });
  await reference.connect();
  let expected;
  try {
    expected = await signatures(reference, "reference");
  } finally {
    await reference.end();
  }

  stage = "reconciliation";
  await client.query("begin isolation level repeatable read");
  transaction = true;
  await client.query(
    "set local lock_timeout='2s'; set local statement_timeout='30s'",
  );
  await client.query(`create temp table repair_preservation(table_name text primary key, n bigint, checksum numeric) on commit drop;
    do $$ declare r record; begin
      for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relname <> 'schema_migrations'
      loop
        execute format('insert into repair_preservation select %L, count(*), coalesce(sum(hashtextextended(t::text,0)::numeric),0) from public.%I t', r.relname, r.relname);
      end loop;
    end $$;`);
  await client.query(
    readFileSync("db/repairs/20261022_runtime_ownership.sql", "utf8"),
  );
  const runtime = (
    await client.query(
      "select current_setting('app.repair_runtime_role') as name",
    )
  ).rows[0].name;
  for (const name of repairFiles) {
    stage = `migration:${name}`;
    await client.query(
      unwrapTransaction(readFileSync(`db/migrations/${name}`, "utf8")),
    );
  }
  for (const name of readdirSync("db/bootstrap")
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    stage = `bootstrap:${name}`;
    let sql = readFileSync(`db/bootstrap/${name}`, "utf8");
    if (name === "001_runtime_role.sql") {
      const marker = "grant usage on schema public to biznoryx_app;";
      assert.equal(sql.split(marker).length, 2);
      sql = sql.slice(sql.indexOf(marker));
    }
    await client.query(sql);
  }
  stage = "preservation-and-equivalence";
  await client.query(`do $$ declare r record; actual_count bigint; actual_checksum numeric; begin
    for r in select table_name, n, checksum from repair_preservation loop
      execute format('select count(*), coalesce(sum(hashtextextended(t::text,0)::numeric),0) from public.%I t',r.table_name)
        into actual_count, actual_checksum;
      if actual_count <> r.n or actual_checksum <> r.checksum then
        raise exception 'Original records changed during reconciliation';
      end if;
    end loop;
  end $$;`);
  const preserved = (
    await client.query("select count(*)::integer as n from repair_preservation")
  ).rows[0].n;
  checkSignatures(expected, await signatures(client, "restored", true));
  stage = "runtime-privileges-and-disabled-flags";
  const identity = (
    await client.query(
      `select r.rolsuper, r.rolbypassrls,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relowner=r.oid) as owns_tables,
    pg_has_role(r.oid,'biznoryx_schema_owner','SET') as can_assume_owner,
    has_schema_privilege(r.oid,'public','CREATE') as can_create
    from pg_roles r where r.rolname=$1`,
      [runtime],
    )
  ).rows[0];
  assert.deepEqual(identity, {
    rolsuper: false,
    rolbypassrls: false,
    owns_tables: false,
    can_assume_owner: false,
    can_create: false,
  });
  assert.equal(
    (
      await client.query(
        "select count(*)::integer as n from organization_features where enabled",
      )
    ).rows[0].n,
    0,
  );
  await client.query("commit");
  transaction = false;
  log(`REPAIR_COMMITTED_ON_FORK: original tables preserved=${preserved}`);
  stage = "schema-equivalence";
  checkSignatures(expected, await signatures(client, "restored"));
  log(
    `SCHEMA_EQUIVALENCE_PASSED: objects=${expected.length}; runtime is non-owner/non-BYPASSRLS; all notifications disabled`,
  );

  stage = "runtime-tests";
  const database = process.env.NF_BIZNORYX_DB_REPAIR_DATABASE;
  runTests(
    "durable-runtime",
    [
      "tests/postgres-runtime.test.mjs",
      "tests/postgres-native-auth.test.mjs",
      "tests/postgres-data-ingestion.test.mjs",
      "tests/billing-webhook-security.test.mjs",
      "tests/policy-security.test.mjs",
      "tests/postgres-evidence-report.test.mjs",
      "tests/postgres-business-actions.test.mjs",
    ],
    { TEST_DATABASE_URL: urlFor(database, runtime) },
  );
  runTests(
    "manual-updates",
    ["tests/postgres-manual-entry.test.mjs", "tests/postgres-updates.test.mjs"],
    {
      TEST_DATABASE_URL: urlFor(database),
      UPDATES_TEST_ADMIN_DATABASE_URL: urlFor(database),
    },
  );

  stage = "ledger";
  await client.query("begin");
  transaction = true;
  for (const filename of readdirSync("db/migrations")
    .filter(
      (n) => /^00(2[5-9]|3[0-3])_.*\.sql$/.test(n) && !n.endsWith(".down.sql"),
    )
    .sort()) {
    await client.query(
      "insert into schema_migrations(filename) values($1) on conflict(filename) do nothing",
      [filename],
    );
  }
  await client.query("commit");
  transaction = false;
  log(
    "ISOLATED_REPAIR_REHEARSAL_PASSED: production unchanged; synthetic test flags exist only on the fork",
  );
}

if (
  process.argv[1]?.endsWith("rehearse-db-repair.mjs") &&
  !process.env.NODE_TEST_CONTEXT
) {
  try {
    await main();
  } catch (error) {
    if (transaction) {
      try {
        await client?.query("rollback");
      } catch {}
    }
    console.error(
      `REHEARSAL_FAILED: stage=${stage}; code=${/^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "CHECK_FAILED"}`,
    );
    const mismatch = error.message?.match(
      /Schema differs: [a-zA-Z0-9_: ]+/,
    )?.[0];
    if (mismatch) console.error(mismatch);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool?.end();
  }
}
