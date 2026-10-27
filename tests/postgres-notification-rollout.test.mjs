import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { buildNotificationRollout } from "../scripts/build-notification-rollout.mjs";

const connectionString = process.env.NOTIFICATION_ROLLOUT_TEST_ADMIN_DATABASE_URL;

test("notification rollout contains provider default grants without changing existing objects", { skip: !connectionString }, async () => {
  const admin = new pg.Client({ connectionString });
  const suffix = randomUUID().replaceAll("-", "");
  const runtime = `updates_runtime_${suffix}`;
  const inherited = `updates_group_${suffix}`;
  await admin.connect();
  await admin.query("begin");
  try {
    assert.equal((await admin.query("select to_regclass('public.organizations') as existing")).rows[0].existing, null, "Use an empty disposable test database");
    await admin.query(`create role ${runtime} nosuperuser nobypassrls;
      create role ${inherited} nosuperuser nobypassrls;
      grant ${inherited} to ${runtime};
      alter default privileges in schema public grant all on tables to public, ${runtime}, ${inherited};
      create table organizations(id uuid primary key, disabled_at timestamptz);
      create table app_users(id uuid primary key, disabled_at timestamptz);
      create table organization_memberships(organization_id uuid, user_id uuid, status text, role text, created_at timestamptz);
      create table ingestion_runs(id uuid primary key, organization_id uuid, status text, reporting_period_id uuid, data_stream_id uuid, created_at timestamptz);
      create table processing_jobs(id uuid, organization_id uuid, ingestion_run_id uuid, status text, job_type text);
      create table verified_metric_points(organization_id uuid, ingestion_run_id uuid);
      create table schema_migrations(filename text primary key);
      insert into organizations(id) values ('00000000-0000-0000-0000-000000000001');`);
    const previous = (await admin.query("select relacl::text as acl from pg_class where oid='public.organizations'::regclass")).rows[0].acl;
    const sql = buildNotificationRollout().replaceAll("\r\n", "\n");
    const body = sql.slice(sql.indexOf("do $$"), sql.lastIndexOf("commit;"));
    await admin.query("select set_config('biznoryx.notification_runtime_role',$1,true)", [runtime]);
    await admin.query(body);
    assert.equal((await admin.query("select relacl::text as acl from pg_class where oid='public.organizations'::regclass")).rows[0].acl, previous);
    assert.equal((await admin.query("select count(*)::integer as n from organizations")).rows[0].n, 1);
    for (const table of ["organization_features", "notification_events", "notification_recipients", "notification_preferences"]) {
      const result = (await admin.query(`select
        has_table_privilege($1::name,$3,'SELECT') as runtime_reads,
        has_table_privilege('public',$3,'SELECT,INSERT,UPDATE,DELETE,TRIGGER,TRUNCATE,REFERENCES,MAINTAIN') as public_access,
        has_table_privilege($2::name,$3,'SELECT,INSERT,UPDATE,DELETE,TRIGGER,TRUNCATE,REFERENCES,MAINTAIN') as inherited_access,
        (select relrowsecurity from pg_class where oid=$3::regclass) as rls`, [runtime, inherited, `public.${table}`])).rows[0];
      assert.deepEqual(result, { runtime_reads: true, public_access: false, inherited_access: false, rls: true });
    }
    await admin.query(`set local role ${runtime}`);
    assert.equal((await admin.query("select has_table_privilege(current_user,'organization_features','INSERT,UPDATE,DELETE') as enabled")).rows[0].enabled, false);
    assert.equal((await admin.query("select has_table_privilege(current_user,'notification_events','INSERT,UPDATE,DELETE') as writable")).rows[0].writable, false);
    assert.equal((await admin.query("select has_column_privilege(current_user,'notification_recipients','read_at','UPDATE') as writable")).rows[0].writable, true);
    assert.equal((await admin.query("select has_column_privilege(current_user,'notification_recipients','user_id','UPDATE') as writable")).rows[0].writable, false);
    assert.equal((await admin.query("select count(*)::integer as n from notification_events")).rows[0].n, 0);
    assert.equal((await admin.query("select deliver_source_updates(1) as delivered")).rows[0].delivered, 0);
    await admin.query("reset role");
    assert.equal((await admin.query("select count(*)::integer as n from organization_features where enabled")).rows[0].n, 0);
    await admin.query(`insert into organizations(id,disabled_at) values
        ('00000000-0000-0000-0000-000000000002',now()),
        ('00000000-0000-0000-0000-000000000006',null);
      insert into app_users(id) values ('00000000-0000-0000-0000-000000000003');
      insert into organization_features(organization_id,feature_key,enabled) values
        ('00000000-0000-0000-0000-000000000001','in_app_updates',false),
        ('00000000-0000-0000-0000-000000000002','in_app_updates',false);
      insert into notification_preferences(organization_id,user_id,category,enabled) values
        ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','reports',false);`);
    const defaults = readFileSync("db/migrations/0034_automatic_business_notifications.sql", "utf8").trim();
    await admin.query(defaults.slice(6, -7));
    const enabled = (await admin.query("select enabled from organization_features order by organization_id")).rows.map(row => row.enabled);
    assert.deepEqual(enabled, [true, false, true]);
    assert.equal((await admin.query("select enabled from notification_preferences")).rows[0].enabled, false);
    assert.equal((await admin.query("select count(*)::integer as n from notification_events")).rows[0].n, 0);
    assert.equal((await admin.query("select relacl::text as acl from pg_class where oid='public.organizations'::regclass")).rows[0].acl, previous);
    await admin.query(`set local role ${runtime}`);
    await admin.query("insert into organizations(id) values ('00000000-0000-0000-0000-000000000004')");
    assert.equal((await admin.query("select has_table_privilege(current_user,'organization_features','INSERT,UPDATE,DELETE') as writable")).rows[0].writable, false);
    await admin.query("reset role");
    assert.equal((await admin.query("select enabled from organization_features where organization_id='00000000-0000-0000-0000-000000000004'")).rows[0].enabled, true);
    await admin.query("savepoint new_business");
    await admin.query(`set local role ${runtime}`);
    await admin.query("insert into organizations(id) values ('00000000-0000-0000-0000-000000000005')");
    await admin.query("reset role");
    await admin.query("rollback to savepoint new_business");
    assert.equal((await admin.query("select count(*)::integer as n from organization_features where organization_id='00000000-0000-0000-0000-000000000005'")).rows[0].n, 0);
  } finally {
    await admin.query("rollback");
    await admin.end();
  }
});
