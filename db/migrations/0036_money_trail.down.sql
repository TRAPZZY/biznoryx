begin;
-- Recovery only: retain populated financial evidence. Disable the application
-- feature instead. Account deletion uses the separately authorized retention path.
do $$
begin
  if exists (select 1 from money_trail_records limit 1) or exists (select 1 from money_trail_imports limit 1) then
    raise exception 'Refusing rollback: Money Trail evidence exists';
  end if;
end;
$$;
drop table money_trail_source_supersessions, money_trail_reversals, money_trail_allocations, money_trail_import_records,
  money_trail_classifications, money_trail_record_states, money_trail_records, money_trail_imports;
drop function money_trail_source_guard(), money_trail_allocation_guard(), money_trail_state_guard(), money_trail_immutable(), money_trail_member(uuid, boolean);
commit;
