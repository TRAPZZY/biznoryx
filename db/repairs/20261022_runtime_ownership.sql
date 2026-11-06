-- Execute only inside the reviewed reconciliation transaction.
do $$
declare
  runtime_oid oid;
  runtime_name text;
  object record;
begin
  select c.relowner, r.rolname into strict runtime_oid, runtime_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_roles r on r.oid = c.relowner
  where n.nspname = 'public' and c.relname = 'ingestion_runs';
  if runtime_name = current_user or exists (
    select 1 from pg_roles where oid = runtime_oid
      and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)
  ) then
    raise exception 'Unexpected runtime ownership or privileges';
  end if;
  if exists (select 1 from pg_roles r where (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb)
    and pg_has_role(runtime_oid, r.oid, 'SET')) then
    raise exception 'Runtime can assume a privileged role; separate review required';
  end if;
  if exists (select 1 from pg_roles where rolname = 'biznoryx_schema_owner') then
    raise exception 'Schema owner already exists; separate review required';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    create role biznoryx_app nologin nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app'
    and (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)) then
    raise exception 'Unexpected application group privileges';
  end if;
  perform set_config('app.repair_runtime_role', runtime_name, true);
  create role biznoryx_schema_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole;
  execute format('grant biznoryx_schema_owner to %I', current_user);
  grant usage, create on schema public to biznoryx_schema_owner;

  if exists (select 1 from pg_database where datname = current_database() and datdba = runtime_oid) then
    execute format('alter database %I owner to biznoryx_schema_owner', current_database());
  end if;
  if exists (select 1 from pg_namespace where nspname = 'public' and nspowner = runtime_oid) then
    alter schema public owner to biznoryx_schema_owner;
  end if;

  for object in select c.relname, c.relkind from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relowner = runtime_oid and c.relkind in ('r', 'p', 'v', 'm', 'S')
    order by case when c.relkind = 'S' then 1 else 0 end, c.relname
  loop
    execute format('alter %s public.%I owner to biznoryx_schema_owner',
      case object.relkind when 'S' then 'sequence' when 'v' then 'view'
        when 'm' then 'materialized view' else 'table' end, object.relname);
  end loop;
  for object in select t.oid::regtype as identity from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typowner = runtime_oid and t.typtype in ('e', 'd')
  loop
    execute format('alter type %s owner to biznoryx_schema_owner', object.identity);
  end loop;
  for object in select p.oid::regprocedure as identity from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proowner = runtime_oid and p.prokind = 'f'
  loop
    execute format('alter function %s owner to biznoryx_schema_owner', object.identity);
  end loop;

  revoke create on schema public from public;
  execute format('revoke create on schema public from %I', runtime_name);
  execute format('revoke truncate, references, trigger on all tables in schema public from %I', runtime_name);
  execute format('revoke update, delete on audit_events from %I', runtime_name);
  execute format('grant biznoryx_app to %I with inherit true', runtime_name);
  if exists (select 1 from pg_roles r where (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb)
    and pg_has_role(runtime_oid, r.oid, 'SET')) then
    raise exception 'Application group grants privileged role access; separate review required';
  end if;
  if pg_has_role(runtime_oid, 'biznoryx_schema_owner', 'SET')
    or pg_has_role('biznoryx_app', 'biznoryx_schema_owner', 'SET') then
    raise exception 'Runtime must not assume schema ownership';
  end if;
end $$;
