import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildNotificationRollout() {
  const migration = readFileSync(
    join(root, "db/migrations/0033_in_app_updates.sql"),
    "utf8",
  ).trim();
  assert.match(migration, /^begin;\s/i);
  assert.match(migration, /\scommit;$/i);
  const body = migration.slice(6, -7);
  return `\\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
select set_config('biznoryx.notification_runtime_role', :'notification_runtime_role', true) is not null;
do $$
declare runtime_target record; object_name text;
begin
  select rolname, rolsuper, rolbypassrls into strict runtime_target
    from pg_roles where rolname = current_setting('biznoryx.notification_runtime_role');
  if runtime_target.rolname = current_user or runtime_target.rolsuper or runtime_target.rolbypassrls then
    raise exception 'Use a separate existing non-superuser, non-BYPASSRLS runtime role';
  end if;
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Existing migration administrator must support cross-tenant delivery functions';
  end if;
  foreach object_name in array array['organizations','app_users','organization_memberships','ingestion_runs','processing_jobs','verified_metric_points','schema_migrations'] loop
    if to_regclass('public.' || object_name) is null then
      raise exception 'Missing notification prerequisite: %', object_name;
    end if;
  end loop;
  foreach object_name in array array['organization_features','notification_events','notification_recipients','notification_preferences','ingestion_runs_id_org_updates_idx'] loop
    if to_regclass('public.' || object_name) is not null then
      raise exception 'Notification object already exists; inspect rather than replay: %', object_name;
    end if;
  end loop;
  if to_regprocedure('public.updates_member(uuid)') is not null
    or to_regprocedure('public.deliver_source_updates(integer)') is not null
    or to_regprocedure('public.enqueue_source_update()') is not null
    or exists(select 1 from pg_trigger where not tgisinternal and tgname in ('ingestion_update_event','processing_update_event'))
    or exists(select 1 from schema_migrations where filename='0033_in_app_updates.sql') then
    raise exception 'Notification setup is already present or partial; inspect before proceeding';
  end if;
end $$;
${body}
do $$
declare runtime_name text := current_setting('biznoryx.notification_runtime_role'); object_name text;
begin
  execute format('grant execute on function public.updates_member(uuid), public.deliver_source_updates(integer) to %I', runtime_name);
  execute format('grant select on public.organization_features, public.notification_events, public.notification_recipients, public.notification_preferences to %I', runtime_name);
  execute format('grant update (read_at, snoozed_until) on public.notification_recipients to %I', runtime_name);
  execute format('grant insert, update on public.notification_preferences to %I', runtime_name);
  foreach object_name in array array['organization_features','notification_events','notification_recipients','notification_preferences'] loop
    if pg_has_role(runtime_name,(select relowner from pg_class where oid=to_regclass('public.'||object_name)),'USAGE') then
      raise exception 'Runtime must not inherit notification table ownership';
    end if;
  end loop;
  if has_table_privilege(runtime_name,'public.organization_features','INSERT,UPDATE,DELETE')
    or exists(select 1 from organization_features where enabled) then
    raise exception 'Runtime must not enable features; production activation remains separate';
  end if;
end $$;
insert into schema_migrations(filename) values ('0033_in_app_updates.sql');
commit;
`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(buildNotificationRollout());
}
