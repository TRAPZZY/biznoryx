do $$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = 'biznoryx_app'
  ) then
    raise exception
      'biznoryx_app runtime role does not exist';
  end if;
end;
$$;

grant
  select,
  insert,
  update,
  delete
on verified_performance_findings
to biznoryx_app;