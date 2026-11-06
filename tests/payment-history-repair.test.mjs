import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { buildPaymentHistoryRepair } from "../scripts/build-payment-history-repair.mjs";
import { PostgresBillingRepository } from "../src/database/billing-repository.mjs";

test("payment history repair reuses canonical schema and never infers completed checkouts are paid", () => {
  const sql = buildPaymentHistoryRepair();
  const migration = readFileSync(
    "db/migrations/0025_billing_payment_history.sql",
    "utf8",
  );
  assert.ok(
    sql.includes(
      migration
        .slice(
          migration.indexOf("create table"),
          migration.indexOf("insert into billing_payments"),
        )
        .trim(),
    ),
  );
  assert.doesNotMatch(
    sql,
    /insert into|update organization|alter role|alter default privileges|create role/i,
  );
  assert.match(sql, /grant select, insert on public\.billing_payments/);
  assert.match(sql, /set local lock_timeout = '2s'/);
});

test(
  "payment history repairs missing storage while preserving tenant isolation, deduplication and existing records",
  {
    skip: !process.env.PAYMENT_HISTORY_TEST_ADMIN_DATABASE_URL,
  },
  async () => {
    const admin = new pg.Client({
      connectionString: process.env.PAYMENT_HISTORY_TEST_ADMIN_DATABASE_URL,
    });
    await admin.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const runtime = `payments_runtime_${suffix}`,
      inherited = `payments_group_${suffix}`;
    const org = randomUUID(),
      other = randomUUID();
    await admin.query("begin");
    try {
      assert.equal(
        (
          await admin.query(
            "select to_regclass('public.organizations') as existing",
          )
        ).rows[0].existing,
        null,
        "Use an empty disposable database",
      );
      await admin.query(`create role ${runtime} nosuperuser nobypassrls;
      create role ${inherited} nosuperuser nobypassrls;
      grant ${inherited} to ${runtime};
      grant usage on schema public to ${runtime};
      create type billing_provider as enum ('paystack','local_review');
      alter default privileges in schema public grant all on tables to public, ${runtime}, ${inherited};
      create table organizations(id uuid primary key, name text);
      create table billing_checkout_sessions(organization_id uuid, reference text, status text);
      insert into billing_checkout_sessions values ('${org}','synthetic-legacy-completed','completed');`);
      await admin.query(
        "insert into organizations values ($1,'Owner business'),($2,'Other business')",
        [org, other],
      );
      const previous = (
        await admin.query(
          "select relacl::text as acl from pg_class where oid='public.organizations'::regclass",
        )
      ).rows[0].acl;
      const sql = buildPaymentHistoryRepair();
      // Execute every SQL statement in the generated transaction, including its
      // schema search path and guards. Only psql's non-secret role substitution
      // and the outer fixture transaction are supplied by this test harness.
      const body = sql
        .slice(sql.indexOf("set local search_path"), sql.lastIndexOf("commit;"))
        .replace(":'payment_history_runtime_role'", `'${runtime}'`);
      await admin.query(
        "select set_config('biznoryx.payment_history_runtime_role',$1,true)",
        [runtime],
      );
      await admin.query(body);
      assert.equal(
        (await admin.query("select count(*)::int as n from billing_payments"))
          .rows[0].n,
        0,
        "Unverified legacy checkouts must not become payments",
      );
      assert.equal(
        (
          await admin.query(
            "select relacl::text as acl from pg_class where oid='public.organizations'::regclass",
          )
        ).rows[0].acl,
        previous,
      );
      assert.equal(
        (
          await admin.query(
            "select count(*)::int as n from billing_checkout_sessions",
          )
        ).rows[0].n,
        1,
      );
      for (const role of ["public", inherited]) {
        assert.equal(
          (
            await admin.query(
              "select has_table_privilege($1,'public.billing_payments','SELECT,INSERT,UPDATE,DELETE') as access",
              [role],
            )
          ).rows[0].access,
          false,
        );
      }
      await admin.query(`set local role ${runtime}`);
      const scopedPool = {
        async connect() {
          return { query: admin.query.bind(admin), release() {} };
        },
      };
      // Exercise real repository transactions inside the outer fixture transaction.
      let savepoint = 0;
      scopedPool.connect = async () => ({
        async query(sql, params) {
          if (sql === "begin") {
            savepoint += 1;
            return admin.query(`savepoint repository_${savepoint}`);
          }
          if (sql === "commit")
            return admin.query(`release savepoint repository_${savepoint}`);
          if (sql === "rollback")
            return admin.query(`rollback to savepoint repository_${savepoint}`);
          return admin.query(sql, params);
        },
        release() {},
      });
      const billing = new PostgresBillingRepository(scopedPool);
      const input = {
        organizationId: org,
        reference: "synthetic-verified-payment",
        status: "success",
        amountMinor: 4000000,
        currency: "NGN",
        channel: "card",
        paidAt: "2026-10-31T12:00:00.000Z",
      };
      const first = await billing.recordPayment(input);
      assert.equal((await billing.recordPayment(input)).id, first.id);
      const history = await billing.listPayments({ organizationId: org });
      assert.equal(history.length, 1);
      assert.equal(history[0].amountMinor, 4000000);
      assert.equal(history[0].reference, input.reference);
      assert.deepEqual(
        await billing.listPayments({ organizationId: other }),
        [],
      );
      await assert.rejects(
        billing.recordPayment({ ...input, organizationId: other }),
        /another workspace/,
      );
      await admin.query(
        "select set_config('app.current_organization_id','',true)",
      );
      assert.equal(
        (await admin.query("select count(*)::int as n from billing_payments"))
          .rows[0].n,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "select has_table_privilege(current_user,'billing_payments','UPDATE,DELETE,TRUNCATE') as access",
          )
        ).rows[0].access,
        false,
      );
      await admin.query("reset role");
      await admin.query("savepoint repeat_repair");
      await assert.rejects(admin.query(body), /already exists or is partial/);
      await admin.query("rollback to savepoint repeat_repair");
    } finally {
      await admin.query("rollback");
      await admin.end();
    }
  },
);
