begin;
set local lock_timeout = '2s';
do $$
begin
  if exists (select 1 from monthly_close_versions) or exists (select 1 from monthly_close_approvals) or exists(select 1 from monthly_source_sets) then
    raise exception 'Refusing rollback: monthly close history exists. Preserve it under the approved retention process.';
  end if;
end;
$$;
drop table monthly_close_approvals;
drop table monthly_close_versions;
drop table monthly_required_sources;
drop table monthly_source_sets;
drop function monthly_close_audit();
drop function monthly_close_approval_guard();
drop function monthly_close_immutable();
commit;
