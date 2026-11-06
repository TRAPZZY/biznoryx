\set ON_ERROR_STOP on
begin read only;
select jsonb_build_object('probe', 'repair_access',
  'runtime_owner_can_set', pg_has_role(current_user, c.relowner, 'SET'),
  'runtime_owner_inherited', pg_has_role(current_user, c.relowner, 'USAGE'),
  'database_owner_can_set', pg_has_role(current_user, d.datdba, 'SET'),
  'runtime_inherits', r.rolinherit,
  'runtime_superuser', r.rolsuper, 'runtime_bypass_rls', r.rolbypassrls,
  'schema_create', has_schema_privilege(current_user, 'public', 'CREATE'))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_roles r on r.oid = c.relowner
join pg_database d on d.datname = current_database()
where n.nspname = 'public' and c.relname = 'ingestion_runs';

select jsonb_build_object('probe', 'runtime_execute', 'function', p.proname,
  'allowed', has_function_privilege(c.relowner, p.oid, 'EXECUTE'),
  'function_owner_can_set', pg_has_role(current_user, p.proowner, 'SET'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join pg_class c join pg_namespace cn on cn.oid = c.relnamespace
where n.nspname = 'public' and cn.nspname = 'public' and c.relname = 'ingestion_runs'
  and p.proname in ('runtime_session_context', 'runtime_active_memberships',
    'runtime_pending_trial_organizations', 'runtime_paystack_trial_organization',
    'claim_ingestion_period_source')
order by p.proname;

select jsonb_build_object('probe', 'index_detail', 'scope', :'probe_scope',
  'table', c.relname, 'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid))
from pg_index i join pg_class c on c.oid = i.indrelid
join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('ingestion_runs', 'organization_billing_subscriptions')
order by c.relname, ic.relname;

select jsonb_build_object('probe', 'trigger_detail', 'scope', :'probe_scope',
  'table', c.relname, 'definition', pg_get_triggerdef(t.oid, false), 'enabled', t.tgenabled)
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('ingestion_runs', 'processing_jobs') and not t.tgisinternal
order by c.relname, t.tgname;
rollback;
