import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildPaymentHistoryRepair() {
  const migration = readFileSync(
    join(root, "db/migrations/0025_billing_payment_history.sql"),
    "utf8",
  ).trim();
  assert.match(migration, /^begin;\s/i);
  const split = migration.indexOf("insert into billing_payments");
  assert.ok(split > 0, "Expected the reviewed schema/backfill boundary");
  const schema = migration.slice(6, split).trim();
  return `\\set ON_ERROR_STOP on
begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
select set_config('biznoryx.payment_history_runtime_role', :'payment_history_runtime_role', true) is not null;
do $$
declare target record;
begin
  select rolname, rolsuper, rolbypassrls into strict target
    from pg_roles where rolname = current_setting('biznoryx.payment_history_runtime_role');
  if target.rolname = current_user or target.rolsuper or target.rolbypassrls then
    raise exception 'Use a separate existing non-superuser, non-BYPASSRLS runtime role';
  end if;
  if to_regclass('public.organizations') is null or to_regtype('public.billing_provider') is null then
    raise exception 'Missing billing schema prerequisites';
  end if;
  if to_regclass('public.billing_payments') is not null
    or to_regclass('public.billing_payments_organization_paid_idx') is not null then
    raise exception 'Payment history already exists or is partial; inspect rather than replay';
  end if;
  if not has_schema_privilege(target.rolname, 'public', 'USAGE') then
    raise exception 'Runtime role must already have schema usage';
  end if;
end $$;
${schema}
do $$
declare runtime_name text := current_setting('biznoryx.payment_history_runtime_role'); inherited_grant record;
begin
  -- Restrict provider defaults on this new table only; preserve database defaults and existing tables.
  for inherited_grant in
    select distinct a.grantee from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    where c.oid = 'public.billing_payments'::regclass and a.grantee <> c.relowner
      and case when a.grantee = 0 then true else pg_has_role(runtime_name, a.grantee, 'USAGE') end
  loop
    if inherited_grant.grantee = 0 then
      revoke all on public.billing_payments from public;
    else
      execute format('revoke all on public.billing_payments from %I', pg_get_userbyid(inherited_grant.grantee));
    end if;
  end loop;
  if pg_has_role(runtime_name, (select relowner from pg_class where oid='public.billing_payments'::regclass), 'USAGE') then
    raise exception 'Runtime must not inherit payment table ownership';
  end if;
  execute format('grant select, insert on public.billing_payments to %I', runtime_name);
  if has_table_privilege(runtime_name,'public.billing_payments','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') then
    raise exception 'Runtime payment access exceeds append/read scope';
  end if;
end $$;
-- No checkout backfill and no migration-ledger claim: the original 0025 backfill is not executed.
commit;
`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(buildPaymentHistoryRepair());
}
