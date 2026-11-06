import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { buildReviewedRecordsRelease } from "../scripts/build-reviewed-records-release.mjs";
import { buildReviewMaintenanceJob } from "../scripts/build-review-maintenance-job.mjs";

test("review release artifact matches canonical migrations and maintenance defaults to read-only", () => {
  const sql = buildReviewedRecordsRelease();
  assert.equal(
    readFileSync(
      "db/releases/reviewed-records-0035-0038.sql",
      "utf8",
    ).replaceAll("\r\n", "\n"),
    sql.replaceAll("\r\n", "\n"),
  );
  const check = buildReviewMaintenanceJob();
  assert.equal(check.mode, "read-only");
  assert.match(check.shell, /begin read only;/);
  assert.doesNotMatch(
    check.shell,
    /create table|alter table|grant select|update business_review_release/i,
  );
  assert.match(check.shell, /PGSSLMODE=verify-full/);
  const apply = buildReviewMaintenanceJob({ apply: true });
  assert.match(apply.shell, /BIZNORYX_REVIEW_SNAPSHOT_ID/);
  assert.match(apply.shell, /BIZNORYX_REVIEW_ROTATION_CONFIRMED/);
  assert.equal(apply.digest, check.digest);
  if (process.platform !== "win32") {
    for (const job of [check, apply]) {
      const syntax = spawnSync("sh", ["-n"], {
        input: job.shell,
        encoding: "utf8",
      });
      assert.equal(syntax.status, 0, syntax.stderr);
      const denied = spawnSync("sh", ["-s"], {
        input: job.shell,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          PGHOST: "biznoryx-db-repair-only",
          PGPORT: "5432",
          PGDATABASE: "synthetic",
          PGUSER: "synthetic",
          PGPASSWORD: "synthetic-not-a-credential",
          BIZNORYX_REVIEW_RUNTIME_ROLE: "synthetic",
        },
      });
      assert.equal(denied.status, 64);
      assert.match(denied.stdout, /REFUSED: test fork/);
      assert.doesNotMatch(denied.stderr, /synthetic-not-a-credential/);
    }
  }
  assert.ok(
    apply.command.length < 100000,
    "Keep below Linux single-argument limits",
  );
});

test(
  "review release contains provider defaults without changing existing grants",
  {
    skip: !process.env.REVIEW_RELEASE_TEST_ADMIN_DATABASE_URL,
  },
  async () => {
    const url = process.env.REVIEW_RELEASE_TEST_ADMIN_DATABASE_URL;
    const suffix = randomUUID().replaceAll("-", "");
    const database = "review_release_" + suffix;
    const runtime = "review_runtime_" + suffix;
    const inherited = "review_group_" + suffix;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    let db;
    try {
      await admin.query(`create role ${runtime} nosuperuser nobypassrls nologin;
      create role ${inherited} nosuperuser nobypassrls nologin;
      grant ${inherited} to ${runtime}`);
      await admin.query(`create database ${database}`);
      const target = new URL(url);
      target.pathname = "/" + database;
      db = new pg.Client({ connectionString: target.toString() });
      await db.connect();
      for (const name of readdirSync("db/migrations").sort()) {
        if (name.endsWith(".down.sql") || name.slice(0, 4) > "0034") continue;
        await db.query(readFileSync(resolve("db/migrations", name), "utf8"));
      }
      await db.query(`grant usage on schema public to ${runtime};
      alter default privileges in schema public grant all on tables to public, ${runtime}, ${inherited}`);
      const prior = (
        await db.query(
          "select relacl::text as acl from pg_class where oid='public.organizations'::regclass",
        )
      ).rows[0].acl;
      const defaults = (
        await db.query(
          "select defaclacl::text as acl from pg_default_acl order by oid",
        )
      ).rows;
      let sql = readFileSync(
        "db/releases/reviewed-records-0035-0038.sql",
        "utf8",
      );
      sql = sql.slice(sql.indexOf("select set_config"));
      sql = sql.replaceAll(":'biznoryx_runtime_role'", "'" + runtime + "'");
      sql = sql.replace(/\\ir ([^\r\n]+)/g, (_, file) =>
        readFileSync(resolve("db/releases", file.trim()), "utf8"),
      );
      // A failure late in the package must roll back every new feature object.
      await assert.rejects(
        db.query(
          sql.replace(
            /commit;\s*$/,
            () =>
              "do $$ begin raise exception 'synthetic stop'; end $$;\ncommit;",
          ),
        ),
        /synthetic stop/,
      );
      await db.query("rollback");
      assert.equal(
        (
          await db.query(
            "select to_regclass('public.import_profiles') as object",
          )
        ).rows[0].object,
        null,
      );
      await db.query(sql);
      assert.equal(
        (await db.query("select enabled from business_review_release")).rows[0]
          .enabled,
        false,
      );
      assert.equal(
        (
          await db.query(
            "select has_table_privilege($1,'business_review_release','INSERT,UPDATE,DELETE,TRUNCATE') as excessive",
            [runtime],
          )
        ).rows[0].excessive,
        false,
        "runtime must not activate the release",
      );
      assert.equal(
        (
          await db.query(
            "select relacl::text as acl from pg_class where oid='public.organizations'::regclass",
          )
        ).rows[0].acl,
        prior,
      );
      assert.deepEqual(
        (
          await db.query(
            "select defaclacl::text as acl from pg_default_acl order by oid",
          )
        ).rows,
        defaults,
      );
      for (const table of [
        "business_review_release",
        "import_profiles",
        "money_trail_records",
        "money_trail_record_states",
        "monthly_close_versions",
      ]) {
        assert.equal(
          (
            await db.query(
              "select has_table_privilege($1,$2,'SELECT') as allowed",
              [runtime, table],
            )
          ).rows[0].allowed,
          true,
        );
        assert.equal(
          (
            await db.query(
              "select has_table_privilege($1,$2,'UPDATE,DELETE,TRUNCATE') as excessive",
              [runtime, table],
            )
          ).rows[0].excessive,
          false,
        );
        for (const role of ["public", inherited]) {
          assert.equal(
            (
              await db.query(
                "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as allowed",
                [role, table],
              )
            ).rows[0].allowed,
            false,
          );
        }
      }
      assert.equal(
        (
          await db.query(
            "select has_column_privilege($1,'money_trail_record_states','version','UPDATE') as allowed",
            [runtime],
          )
        ).rows[0].allowed,
        true,
      );
      await db.query(`set role ${runtime}`);
      await assert.rejects(
        db.query("update business_review_release set enabled=true"),
        /permission denied/i,
      );
      await db.query("reset role");
    } finally {
      await db?.end();
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.query(`drop role if exists ${runtime}, ${inherited}`);
      await admin.end();
    }
  },
);
