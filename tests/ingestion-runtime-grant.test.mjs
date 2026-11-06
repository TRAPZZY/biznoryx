import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { buildIngestionRuntimeGrant } from "../scripts/build-ingestion-runtime-grant.mjs";

test("upload grant package changes only the reviewed invoker helper permission", () => {
  const sql = buildIngestionRuntimeGrant();
  assert.match(sql, /grant execute on function public\.claim_ingestion_period_source\(uuid,uuid,text,text\) to %I/);
  assert.doesNotMatch(sql, /grant all|security definer|alter table|create table|alter role|alter default|insert into|update public/i);
  assert.match(sql, /helper\.prosecdef/);
  assert.match(sql, /relrowsecurity and relforcerowsecurity/);
});

test("custom runtime upload claim recovers without bypassing tenant or source-mode guards", {
  skip: !process.env.RUNTIME_GRANT_TEST_ADMIN_DATABASE_URL,
}, async () => {
  const client = new pg.Client({ connectionString: process.env.RUNTIME_GRANT_TEST_ADMIN_DATABASE_URL });
  const runtime = `upload_runtime_${randomUUID().replaceAll("-", "")}`;
  const org = randomUUID(), other = randomUUID(), stream = randomUUID();
  await client.connect();
  await client.query("begin");
  try {
    assert.equal((await client.query("select to_regclass('public.manual_entry_period_sources') as existing")).rows[0].existing, null, "Use an empty disposable database");
    await client.query(`create role ${runtime} nosuperuser nobypassrls;
      create table manual_entry_period_sources(organization_id uuid, data_stream_id uuid, period text, input_mode text, primary key(organization_id,data_stream_id,period));
      create table ingestion_runs(organization_id uuid, data_stream_id uuid, reporting_period_id uuid, manual_submission_id uuid, status text);
      create table reporting_periods(id uuid, period_start date);
      alter table manual_entry_period_sources enable row level security;
      alter table manual_entry_period_sources force row level security;
      create policy scoped_source on manual_entry_period_sources
        using (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
        with check (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
      grant select,insert on manual_entry_period_sources to ${runtime};
      grant select on ingestion_runs,reporting_periods to ${runtime};`);
    const migration = readFileSync("db/migrations/0031_manual_data_entry.sql", "utf8").replaceAll("\r\n", "\n");
    const helper = migration.match(/create function claim_ingestion_period_source\([\s\S]*?\$\$;/)[0];
    await client.query(helper);
    await client.query("revoke all on function claim_ingestion_period_source(uuid,uuid,text,text) from public");
    const definition = (await client.query("select pg_get_functiondef('claim_ingestion_period_source(uuid,uuid,text,text)'::regprocedure) as definition")).rows[0].definition;
    const tableAcl = (await client.query("select relacl::text as acl from pg_class where oid='manual_entry_period_sources'::regclass")).rows[0].acl;
    async function denied(query, params, code) {
      await client.query("savepoint denied");
      await assert.rejects(client.query(query, params), { code });
      await client.query("rollback to savepoint denied");
    }
    await client.query(`set local role ${runtime}`);
    await client.query("select set_config('app.current_organization_id',$1,true)", [org]);
    await denied("select claim_ingestion_period_source($1,$2,'2026-10','full_file')", [org, stream], "42501");
    await client.query("reset role");
    await client.query("select set_config('biznoryx.ingestion_runtime_role',$1,true)", [runtime]);
    const sql = buildIngestionRuntimeGrant();
    const repair = sql.slice(sql.indexOf("do $$"), sql.lastIndexOf("commit;"));
    await client.query(repair);
    await client.query(repair);
    assert.equal((await client.query("select pg_get_functiondef('claim_ingestion_period_source(uuid,uuid,text,text)'::regprocedure) as definition")).rows[0].definition, definition);
    assert.equal((await client.query("select relacl::text as acl from pg_class where oid='manual_entry_period_sources'::regclass")).rows[0].acl, tableAcl);
    assert.equal((await client.query("select count(*)::int as n from manual_entry_period_sources")).rows[0].n, 0);
    await client.query(`set local role ${runtime}`);
    await client.query("select claim_ingestion_period_source($1,$2,'2026-10','full_file')", [org, stream]);
    await client.query("select claim_ingestion_period_source($1,$2,'2026-10','full_file')", [org, stream]);
    await denied("select claim_ingestion_period_source($1,$2,'2026-10','manual_entry')", [org, stream], "23514");
    await client.query("select claim_ingestion_period_source($1,$2,'2026-11','manual_entry')", [org, stream]);
    await denied("select claim_ingestion_period_source($1,$2,'2026-11','full_file')", [org, stream], "23514");
    await denied("select claim_ingestion_period_source($1,$2,'2026-10','full_file')", [other, stream], "42501");
    await client.query("select set_config('app.current_organization_id','',true)");
    await denied("select claim_ingestion_period_source($1,$2,'2026-10','full_file')", [org, stream], "42501");
    await client.query("reset role");
    const publicGrant = (await client.query(`select count(*)::int as n from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid='claim_ingestion_period_source(uuid,uuid,text,text)'::regprocedure and a.grantee=0`)).rows[0].n;
    assert.equal(publicGrant, 0);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
