begin;
drop policy audit_events_select_rls on audit_events;
create policy audit_events_select_rls on audit_events
  for select
  using (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );
commit;
