import { createPostgresPool } from "../src/database/postgres.mjs";

// Read-only release check. DATABASE_URL stays in the process environment.
// Never log connection strings, secrets, customer rows or payment records.
const tables = [
  "import_profiles",
  "ingestion_import_manifests",
  "money_trail_imports",
  "money_trail_records",
  "money_trail_record_states",
  "money_trail_classifications",
  "money_trail_import_records",
  "money_trail_allocations",
  "money_trail_reversals",
  "money_trail_source_supersessions",
  "monthly_source_sets",
  "monthly_required_sources",
  "monthly_close_versions",
  "monthly_close_approvals",
];
const pool = createPostgresPool();
try {
  const role = await pool.query(
    `select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`,
  );
  const result = await pool.query(
    `select requested.name,c.oid is not null as present,
    coalesce(c.relrowsecurity,false) as rls,coalesce(c.relforcerowsecurity,false) as forced,
    coalesce(pg_get_userbyid(c.relowner)=current_user,false) as runtime_owns_table,
    case when c.oid is null then false else has_table_privilege(c.oid,'SELECT') and has_table_privilege(c.oid,'INSERT') end as permitted
    from unnest($1::text[]) requested(name) left join pg_namespace n on n.nspname='public'
    left join pg_class c on c.relnamespace=n.oid and c.relname=requested.name order by requested.name`,
    [tables],
  );
  const notifications =
    await pool.query(`select exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='notification_events' and column_name='review_target_id') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='ingestion_import_manifests' and column_name='normalization') as ready`);
  const member = await pool.query(
    "select to_regprocedure('public.money_trail_member(uuid,boolean)') as helper",
  );
  const functions = member.rows[0].helper
    ? await pool.query(
        "select has_function_privilege('public.money_trail_member(uuid,boolean)','EXECUTE') as ready",
      )
    : { rows: [{ ready: false }] };
  const state = tables.filter(
    (name) =>
      name === "money_trail_record_states" &&
      result.rows.find((r) => r.name === name)?.present,
  ).length
    ? await pool.query(
        "select has_column_privilege('public.money_trail_record_states','version','UPDATE') as ready",
      )
    : { rows: [{ ready: false }] };
  const releaseTable = await pool.query(`select c.oid is not null as present,
    coalesce(pg_get_userbyid(c.relowner)=current_user,false) as runtime_owns_table,
    case when c.oid is null then false else has_table_privilege(c.oid,'SELECT')
      and not has_table_privilege(c.oid,'UPDATE') and not has_table_privilege(c.oid,'INSERT')
      and not has_table_privilege(c.oid,'DELETE') end as permitted
    from (select to_regclass('public.business_review_release') as id) requested
    left join pg_class c on c.oid=requested.id`);
  const releaseGrant = releaseTable.rows[0];
  const release =
    releaseGrant.present && releaseGrant.permitted
      ? await pool.query(
          "select enabled, pilot_organization_id is not null as pilot_configured from business_review_release where singleton",
        )
      : { rows: [] };
  const releaseReady =
    releaseGrant.present &&
    releaseGrant.permitted &&
    !releaseGrant.runtime_owns_table &&
    release.rows.length === 1;
  const secure = !role.rows[0].rolsuper && !role.rows[0].rolbypassrls;
  const ready =
    secure &&
    releaseReady &&
    result.rows.every(
      (r) =>
        r.present && r.rls && r.forced && !r.runtime_owns_table && r.permitted,
    ) &&
    notifications.rows[0].ready &&
    functions.rows[0].ready &&
    state.rows[0].ready;
  process.stdout.write(
    JSON.stringify(
      {
        ready,
        runtimeRole: role.rows[0].name,
        restrictedRuntime: secure,
        releaseControlReady: releaseReady,
        releaseEnabled: release.rows[0]?.enabled ?? false,
        pilotConfigured: release.rows[0]?.pilot_configured ?? false,
        tables: result.rows,
        notificationsReady: notifications.rows[0].ready,
        helperReady: functions.rows[0].ready,
        stateUpdateReady: state.rows[0].ready,
      },
      null,
      2,
    ),
  );
  if (!ready) process.exitCode = 1;
} catch (error) {
  console.error(
    `Business review schema check failed (${error.code ?? "UNAVAILABLE"}). No data was changed.`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
