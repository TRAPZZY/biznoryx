import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { unwrapTransaction } from "../scripts/rehearse-db-repair.mjs";

const connectionString = process.env.LOCAL_DB_REPAIR_TEST_URL;
const repairNumbers = new Set([25, 27, 28, 29, 33]);
const sqlFiles = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .sort();

async function grants(client) {
  for (const name of sqlFiles("db/bootstrap")) {
    let sql = readFileSync(`db/bootstrap/${name}`, "utf8");
    if (name === "001_runtime_role.sql")
      sql = sql.slice(
        sql.indexOf("grant usage on schema public to biznoryx_app;"),
      );
    await client.query(sql);
  }
}

async function fingerprints(client) {
  const sql = readFileSync("db/diagnostics/schema-fingerprints.sql", "utf8")
    .replace("\\set ON_ERROR_STOP on", "")
    .replace("begin read only;", "")
    .replaceAll(":'probe_scope'", "'synthetic'")
    .replace(/rollback;\s*$/, "");
  const results = await client.query(sql);
  return results
    .flatMap((result) => result.rows ?? [])
    .map((row) =>
      Object.fromEntries(
        Object.entries(row.jsonb_build_object).filter(
          ([key]) => !["owner", "scope"].includes(key),
        ),
      ),
    );
}

test(
  "local-only synthetic ownership and missing-schema repair",
  { skip: !connectionString },
  async (t) => {
    const url = new URL(connectionString);
    assert.ok(["postgresql:", "postgres:"].includes(url.protocol));
    assert.equal(url.search, "", "Connection overrides are not allowed");
    assert.equal(url.hash, "");
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "Only loopback databases are allowed",
    );
    assert.equal(url.pathname, "/biznoryx_local_repair_test");
    const client = new pg.Client({ connectionString });
    await client.connect();
    t.after(() => client.end());
    assert.equal(
      (
        await client.query(
          "select count(*)::integer as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')",
        )
      ).rows[0].n,
      0,
      "Requires an empty disposable database",
    );
    assert.equal(
      (await client.query("select to_regclass('public.app_users') as existing"))
        .rows[0].existing,
      null,
      "Requires a new disposable database",
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::integer as n from pg_roles where rolname in ('biznoryx_app','biznoryx_repair_fixture','biznoryx_schema_owner')",
        )
      ).rows[0].n,
      0,
      "Requires an isolated cluster without application roles",
    );
    await client.query(`create role biznoryx_app nologin nosuperuser nobypassrls nocreatedb nocreaterole;
    create role biznoryx_repair_fixture nologin nosuperuser nobypassrls nocreatedb nocreaterole;
    grant usage, create on schema public to biznoryx_repair_fixture;
    create extension if not exists pgcrypto;`);
    await client.query(
      "create database biznoryx_local_repair_reference template template0",
    );
    const referenceUrl = new URL(url);
    referenceUrl.pathname = "/biznoryx_local_repair_reference";
    const reference = new pg.Client({ connectionString: referenceUrl.href });
    await reference.connect();
    let expected;
    try {
      for (const name of sqlFiles("db/migrations"))
        await reference.query(readFileSync(`db/migrations/${name}`, "utf8"));
      await grants(reference);
      await reference.query("begin read only");
      expected = await fingerprints(reference);
      await reference.query("rollback");
    } finally {
      await reference.end();
    }

    // Reconstruct the observed shape using fictional records, never a production copy.
    for (const name of sqlFiles("db/migrations")) {
      const number = Number(name.slice(0, 4));
      if (repairNumbers.has(number)) continue;
      await client.query(
        number <= 24 ? "set role biznoryx_repair_fixture" : "reset role",
      );
      await client.query(readFileSync(`db/migrations/${name}`, "utf8"));
    }
    await client.query("reset role");
    const userId = randomUUID(),
      orgId = randomUUID(),
      otherOrgId = randomUUID();
    await client.query(
      "insert into app_users(id,email,display_name,password_hash) values($1,'synthetic-repair@example.invalid','Synthetic repair','not-a-login-credential')",
      [userId],
    );
    await client.query(
      "insert into organizations(id,name,slug,created_by_user_id) values($1,'Synthetic A','synthetic-repair-a',$3),($2,'Synthetic B','synthetic-repair-b',$3)",
      [orgId, otherOrgId, userId],
    );
    await client.query(
      "insert into organization_memberships(organization_id,user_id,role,status) values($1,$2,'owner','active')",
      [orgId, userId],
    );
    await client.query(
      `insert into billing_checkout_sessions(organization_id,actor_user_id,provider,reference,status,plan_id,plan_name,currency,amount_minor,billing_interval,completed_at)
    values($1,$2,'paystack','synthetic-repair-payment','completed','fixture','Synthetic plan','NGN',500000,'monthly',now())`,
      [orgId, userId],
    );
    const originals = (
      await client.query(
        "select row_to_json(o) as row from organizations o order by id",
      )
    ).rows;

    await t.test(
      "repair is transactional and a rollback restores legacy ownership",
      async () => {
        await client.query("begin");
        try {
          await client.query(
            readFileSync("db/repairs/20261022_runtime_ownership.sql", "utf8"),
          );
        } finally {
          await client.query("rollback");
        }
        assert.equal(
          (
            await client.query(
              "select pg_get_userbyid(relowner) as owner from pg_class where oid='ingestion_runs'::regclass",
            )
          ).rows[0].owner,
          "biznoryx_repair_fixture",
        );
        assert.equal(
          (
            await client.query(
              "select count(*)::integer as n from pg_roles where rolname='biznoryx_schema_owner'",
            )
          ).rows[0].n,
          0,
        );
      },
    );

    await t.test(
      "application group cannot introduce privileged role access",
      async () => {
        await client.query("begin");
        try {
          await client.query(
            "create role biznoryx_repair_privilege_fixture nologin createdb; grant biznoryx_repair_privilege_fixture to biznoryx_app",
          );
          await assert.rejects(
            client.query(
              readFileSync("db/repairs/20261022_runtime_ownership.sql", "utf8"),
            ),
            (error) =>
              error.code === "P0001" &&
              /Application group grants privileged role access/.test(
                error.message,
              ),
          );
        } finally {
          await client.query("rollback");
        }
        assert.equal(
          (
            await client.query(
              "select count(*)::integer as n from pg_roles where rolname='biznoryx_schema_owner'",
            )
          ).rows[0].n,
          0,
        );
      },
    );

    await t.test(
      "targeted repair matches the canonical schema without changing original rows",
      async () => {
        await client.query("begin");
        try {
          await client.query(
            readFileSync("db/repairs/20261022_runtime_ownership.sql", "utf8"),
          );
          for (const name of sqlFiles("db/migrations").filter((name) =>
            repairNumbers.has(Number(name.slice(0, 4))),
          )) {
            await client.query(
              unwrapTransaction(readFileSync(`db/migrations/${name}`, "utf8")),
            );
          }
          await grants(client);
          assert.deepEqual(await fingerprints(client), expected);
          assert.deepEqual(
            (
              await client.query(
                "select row_to_json(o) as row from organizations o order by id",
              )
            ).rows,
            originals,
          );
          assert.deepEqual(
            (
              await client.query(
                "select reference, amount_minor::text as amount from billing_payments",
              )
            ).rows,
            [{ reference: "synthetic-repair-payment", amount: "500000" }],
          );
          assert.equal(
            (
              await client.query(
                "select count(*)::integer as n from organization_features where enabled",
              )
            ).rows[0].n,
            0,
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      },
    );

    await t.test(
      "repaired runtime cannot own tables, assume schema ownership or bypass tenant RLS",
      async () => {
        await client.query("begin; set local role biznoryx_repair_fixture");
        try {
          assert.deepEqual(
            (
              await client.query(`select rolsuper, rolbypassrls,
        pg_has_role(current_user,'biznoryx_schema_owner','SET') as can_assume_owner,
        has_schema_privilege(current_user,'public','CREATE') as can_create,
        exists(select 1 from pg_class where relowner=(select oid from pg_roles where rolname=current_user)) as owns_tables
        from pg_roles where rolname=current_user`)
            ).rows[0],
            {
              rolsuper: false,
              rolbypassrls: false,
              can_assume_owner: false,
              can_create: false,
              owns_tables: false,
            },
          );
          assert.equal(
            (
              await client.query(
                "select count(*)::integer as n from organizations",
              )
            ).rows[0].n,
            0,
          );
          await client.query(
            "select set_config('app.current_organization_id',$1,true),set_config('app.current_user_id',$2,true)",
            [orgId, userId],
          );
          assert.deepEqual(
            (await client.query("select id from organizations")).rows,
            [{ id: orgId }],
          );
          assert.equal(
            (
              await client.query(
                "select count(*)::integer as n from runtime_active_memberships($1)",
                [userId],
              )
            ).rows[0].n,
            1,
          );
          await client.query(
            "select organization_id from runtime_pending_trial_organizations(10)",
          );
        } finally {
          await client.query("rollback");
        }
      },
    );
  },
);
