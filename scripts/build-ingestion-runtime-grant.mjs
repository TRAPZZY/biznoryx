import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildIngestionRuntimeGrant() {
  const migration = readFileSync(join(root, "db/migrations/0031_manual_data_entry.sql"), "utf8").replaceAll("\r\n", "\n");
  const body = migration.match(/create function claim_ingestion_period_source\([\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(body, "The existing source-claim helper must be present");
  const digest = createHash("md5").update(body).digest("hex");
  return `\\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
select set_config('biznoryx.ingestion_runtime_role', :'ingestion_runtime_role', true) is not null;
do $$
declare runtime_name text := current_setting('biznoryx.ingestion_runtime_role'); target record; helper record;
begin
  select rolname, rolsuper, rolbypassrls into strict target from pg_roles where rolname = runtime_name;
  if runtime_name = current_user or target.rolsuper or target.rolbypassrls then
    raise exception 'Use the separate existing restricted API runtime role';
  end if;
  select p.* into strict helper from pg_proc p
    where p.oid = 'public.claim_ingestion_period_source(uuid,uuid,text,text)'::regprocedure;
  if helper.prosecdef or md5(helper.prosrc) <> '${digest}'
    or helper.proconfig is distinct from array['search_path=public, pg_temp']::text[] then
    raise exception 'Source-claim helper differs from reviewed migration 0031';
  end if;
  if exists(select 1 from aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
    where a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'Unexpected PUBLIC helper access; inspect separately';
  end if;
  if not has_table_privilege(runtime_name,'public.manual_entry_period_sources','SELECT')
    or not has_table_privilege(runtime_name,'public.manual_entry_period_sources','INSERT')
    or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.manual_entry_period_sources'::regclass) then
    raise exception 'Existing runtime source-table grants and forced RLS are required';
  end if;
  execute format('grant execute on function public.claim_ingestion_period_source(uuid,uuid,text,text) to %I',runtime_name);
  if not has_function_privilege(runtime_name,helper.oid,'EXECUTE') then
    raise exception 'Runtime source-claim grant was not applied';
  end if;
end $$;
commit;
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(buildIngestionRuntimeGrant());
}
