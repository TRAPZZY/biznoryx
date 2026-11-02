\set ON_ERROR_STOP on
\if :{?biznoryx_runtime_role}
\else
  \echo 'Supply the verified existing runtime role with -v biznoryx_runtime_role=ROLE. Do not use a guessed role.'
  \quit 2
\endif
select set_config('app.review_runtime_role', :'biznoryx_runtime_role', false) is not null;
do $$
declare runtime_role record;
begin
  select rolname,rolsuper,rolbypassrls into runtime_role from pg_roles where rolname=current_setting('app.review_runtime_role');
  if runtime_role.rolname is null or runtime_role.rolsuper or runtime_role.rolbypassrls or runtime_role.rolname=current_user then
    raise exception 'A verified, separate, restricted runtime role is required. Do not modify ownership or credentials through this release.';
  end if;
  if to_regclass('public.ingestion_runs') is null or to_regclass('public.manual_entry_period_sources') is null
    or to_regclass('public.evidence_report_definitions') is null or to_regclass('public.notification_events') is null
    or to_regprocedure('public.deliver_source_updates(integer)') is null then
    raise exception 'A required existing schema component is missing. Inspect compatibility; do not replay historical migrations blindly.';
  end if;
  if to_regclass('public.ingestion_import_manifests') is not null or to_regclass('public.money_trail_records') is not null
    or to_regclass('public.monthly_close_versions') is not null then
    raise exception 'This release is already partly or fully installed. Inspect it instead of rerunning this bundle.';
  end if;
end $$;

-- Run only after the operator has verified recovery and the reviewed revision.
-- Each migration has a bounded lock wait and its own atomic transaction.
\ir ../migrations/0035_reviewed_imports.sql
\ir ../migrations/0036_money_trail.sql
\ir ../migrations/0037_monthly_close.sql
\ir ../migrations/0038_review_updates.sql

begin;
do $$
declare role_name text:=current_setting('app.review_runtime_role');
begin
  execute format('grant select on business_review_release to %I',role_name);
  execute format('grant select,insert on import_profiles,ingestion_import_manifests,
    money_trail_imports,money_trail_records,money_trail_record_states,money_trail_classifications,
    money_trail_import_records,money_trail_allocations,money_trail_reversals,money_trail_source_supersessions,
    monthly_source_sets,monthly_required_sources,monthly_close_versions,monthly_close_approvals to %I',role_name);
  execute format('grant update(version,kind,payment_status,due_date,reference_confirmed) on money_trail_record_states to %I',role_name);
  execute format('grant execute on function money_trail_member(uuid,boolean) to %I',role_name);
end $$;
commit;
