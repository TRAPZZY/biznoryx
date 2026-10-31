\set ON_ERROR_STOP on
begin read only;
set local statement_timeout = '15s';
set local lock_timeout = '1s';

select jsonb_build_object('probe', 'table_signature', 'scope', :'probe_scope',
  'name', c.relname, 'owner', pg_get_userbyid(c.relowner),
  'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity,
  'columns_md5', (select md5(coalesce(jsonb_agg(jsonb_build_object(
      'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'required', a.attnotnull, 'generated', a.attgenerated,
      'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)::text, '[]'))
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
  'constraints_md5', (select md5(coalesce(jsonb_agg(jsonb_build_object(
      'name', x.conname, 'definition', pg_get_constraintdef(x.oid, false),
      'validated', x.convalidated) order by x.conname)::text, '[]'))
    from pg_constraint x where x.conrelid = c.oid),
  'indexes_md5', (select md5(coalesce(jsonb_agg(jsonb_build_object(
      'definition', pg_get_indexdef(x.indexrelid), 'valid', x.indisvalid)
      order by pg_get_indexdef(x.indexrelid))::text, '[]'))
    from pg_index x where x.indrelid = c.oid),
  'policies_md5', (select md5(coalesce(jsonb_agg(jsonb_build_object(
      'name', x.polname, 'command', x.polcmd, 'permissive', x.polpermissive,
      'roles', (select jsonb_agg(case when r = 0 then 'public' else pg_get_userbyid(r) end order by r)
        from unnest(x.polroles) r),
      'using', pg_get_expr(x.polqual, x.polrelid),
      'check', pg_get_expr(x.polwithcheck, x.polrelid)) order by x.polname)::text, '[]'))
    from pg_policy x where x.polrelid = c.oid),
  'triggers_md5', (select md5(coalesce(jsonb_agg(jsonb_build_object(
      'definition', pg_get_triggerdef(x.oid, false), 'enabled', x.tgenabled)
      order by x.tgname)::text, '[]'))
    from pg_trigger x where x.tgrelid = c.oid and not x.tgisinternal))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
order by c.relname;

select jsonb_build_object('probe', 'function_signature', 'scope', :'probe_scope',
  'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
  'definition_md5', md5(replace(pg_get_functiondef(p.oid), chr(13), '')),
  'owner', pg_get_userbyid(p.proowner), 'definer', p.prosecdef,
  'settings', p.proconfig,
  'public_execute', exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where x.grantee = 0 and x.privilege_type = 'EXECUTE'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and (
  p.proname like 'runtime_%' or p.proname in (
    'updates_member', 'deliver_source_updates', 'enqueue_source_update',
    'claim_ingestion_period_source', 'manual_entry_immutable', 'enforce_manual_ingestion_source'))
order by p.proname;

rollback;
