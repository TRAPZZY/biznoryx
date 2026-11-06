import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  buildReferenceRehearsal,
  buildRepairRehearsal,
  jobCommand,
} from "../scripts/build-db-rehearsal.mjs";
import {
  assertForkEnvironment,
  checkSignatures,
  unwrapTransaction,
} from "../scripts/rehearse-db-repair.mjs";

test("reference rehearsal is fork-guarded and never reuses a database", () => {
  const script = buildReferenceRehearsal();
  assert.ok(
    !script
      .slice(0, script.indexOf('RESTORED_DATABASE="$PGDATABASE"'))
      .includes("\r"),
  );
  assert.ok(script.indexOf('case "$PGHOST"') < script.indexOf("createdb -w"));
  assert.match(script, /\*biznoryx-db-repair\*/);
  assert.match(script, /PGSSLMODE=verify-full PGSSLROOTCERT=system/);
  assert.match(script, /--template=template0/);
  assert.match(script, /never reusing or dropping an existing database/);
  assert.match(script, /PGDATABASE="\$REFERENCE_DATABASE"/);
  assert.doesNotMatch(
    script,
    /drop database|drop role|biznoryx_app_password|local_runtime_password_change_me/i,
  );
});

test("rehearsal uses existing forward migrations and all SQL acceptance cases", () => {
  const script = buildReferenceRehearsal();
  for (const directory of ["db/migrations", "db/bootstrap", "db/acceptance"]) {
    for (const name of readdirSync(directory).filter(
      (n) => n.endsWith(".sql") && !n.endsWith(".down.sql"),
    )) {
      assert.ok(script.includes(name), `${directory}/${name} missing`);
      if (name !== "001_runtime_role.sql") {
        assert.ok(
          script.includes(readFileSync(`${directory}/${name}`, "utf8")),
        );
      }
    }
  }
  assert.match(
    script,
    /create role biznoryx_app nologin nosuperuser nobypassrls nocreatedb nocreaterole/,
  );
  const restored = script.slice(
    script.indexOf('export PGDATABASE="$RESTORED_DATABASE"'),
  );
  assert.match(restored, /default_transaction_read_only=on/);
  assert.doesNotMatch(restored, /run_sql|createdb|create role/);
});

test("job command preserves the script exactly without multiline argument loss", () => {
  const script = buildReferenceRehearsal();
  const command = jobCommand(script);
  assert.ok(!command.includes("\n"));
  assert.ok(Buffer.byteLength(command) < 128 * 1024);
  const encoded = command.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)[1];
  assert.equal(gunzipSync(Buffer.from(encoded, "base64")).toString(), script);
});

test("repair runner rejects production targets and unrelated credentials", () => {
  const env = {
    BIZNORYX_REHEARSAL_CONFIRM: "isolated-fork-only",
    NF_BIZNORYX_DB_REPAIR_HOST: "biznoryx-db-repair.internal",
    NF_BIZNORYX_DB_REPAIR_PORT: "5432",
    NF_BIZNORYX_DB_REPAIR_DATABASE: "fixture",
    NF_BIZNORYX_DB_REPAIR_ADMIN_USERNAME: "fixture",
    NF_BIZNORYX_DB_REPAIR_ADMIN_PASSWORD: "fixture-only",
  };
  assert.doesNotThrow(() => assertForkEnvironment(env));
  assert.throws(() =>
    assertForkEnvironment({
      ...env,
      NF_BIZNORYX_DB_REPAIR_HOST: "biznoryx-db.internal",
    }),
  );
  assert.throws(() =>
    assertForkEnvironment({ ...env, BIZNORYX_REHEARSAL_CONFIRM: undefined }),
  );
  for (const key of [
    "DATABASE_URL",
    "DATABASE_URI",
    "TEST_DATABASE_URL",
    "NF_BIZNORYX_DB_ADMIN_PASSWORD",
    "NF_BIZNORYX_DB_HOST",
    "RESEND_API_KEY",
    "PAYSTACK_SECRET_KEY",
    "BIZNORYX_BILLING_ENCRYPTION_KEY",
    "BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID",
    "BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY",
    "ANDROID_UPLOAD_STORE_PASSWORD",
    "GITHUB_TOKEN",
    "NF_BIZNORYX_DB_REPAIR_UNAPPROVED_TOKEN",
  ]) {
    assert.throws(() =>
      assertForkEnvironment({ ...env, [key]: "fixture-only" }),
    );
  }
  assert.doesNotThrow(() =>
    assertForkEnvironment({
      ...env,
      DATABASE_URL: "",
      PGPASSWORD: "fixture-only",
    }),
  );
  assert.throws(() =>
    assertForkEnvironment({ ...env, PGPASSWORD: "unrelated" }),
  );
});

test("shell credential guard exits before dependencies, connections or downloads", () => {
  const script = buildRepairRehearsal(
    Array.from({ length: 21 }, (_, index) => ({
      scope: "restored",
      name: `fixture_${index}`,
    })),
  );
  assert.ok(
    script.indexOf("unrelated credential environment") <
      script.indexOf("apt-get"),
  );
  assert.ok(
    script.indexOf("unrelated credential environment") <
      script.indexOf("curl --fail"),
  );
  const bash =
    process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const result = spawnSync(bash, ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, RESEND_API_KEY: "synthetic-guard-test-only" },
    timeout: 10000,
  });
  assert.equal(result.status, 64);
  assert.equal(
    result.stdout.trim(),
    "REFUSED: unrelated credential environment",
  );
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-guard-test-only/,
  );
});

test("migration wrapper removal preserves nested SQL and rejects unexpected boundaries", () => {
  const body = "\ndo $$ begin perform 1; end $$;\n";
  assert.equal(unwrapTransaction(`begin;${body}commit;`), body);
  assert.throws(() => unwrapTransaction("select 1;"));
  assert.throws(() => unwrapTransaction("begin; select 1;"));
});

test("final schema equality rejects unexpected objects while partial baselines stay explicit", () => {
  const expected = [
    {
      probe: "table_signature",
      name: "fixture",
      owner: "reference-owner",
      scope: "reference",
      columns_md5: "abc",
    },
  ];
  const actual = [
    {
      ...expected[0],
      owner: "repaired-owner",
      scope: "restored",
      columns_md5: "abc ",
    },
  ];
  const extra = { ...actual[0], name: "unexpected_fixture" };
  assert.doesNotThrow(() => checkSignatures(expected, actual));
  assert.throws(
    () => checkSignatures(expected, [...actual, extra]),
    /Unexpected schema objects/,
  );
  assert.throws(() => checkSignatures(expected, []));
  assert.throws(
    () => checkSignatures(expected, [...actual, actual[0]]),
    /Duplicate schema object signatures/,
  );
  assert.doesNotThrow(() =>
    checkSignatures(expected, [...actual, extra], { allowAdditional: true }),
  );
});

test("repair packaging requires a baseline and pins tested application and verified Node archive", () => {
  assert.throws(() => buildRepairRehearsal([]));
  const baseline = Array.from({ length: 21 }, (_, index) => ({
    scope: "restored",
    name: `fixture_${index}`,
  }));
  const script = buildRepairRehearsal(baseline);
  assert.match(script, /ef014a524847914113a81e030f8c1132f0787778/);
  assert.match(script, /sha256sum --check --status/);
  assert.match(script, /npm ci --ignore-scripts --omit=dev/);
  assert.match(script, /unset PGOPTIONS/);
  assert.match(script, /BIZNORYX_REHEARSAL_CONFIRM=isolated-fork-only/);
  assert.ok(Buffer.byteLength(jobCommand(script)) < 128 * 1024);
});
