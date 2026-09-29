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
on verified_metric_definitions
to biznoryx_app;

grant
  select,
  insert,
  update,
  delete
on verified_metric_points
to biznoryx_app;