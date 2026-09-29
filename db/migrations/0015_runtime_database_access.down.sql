begin;

drop function if exists runtime_session_context(text);
drop function if exists runtime_active_memberships(uuid);
drop policy if exists audit_events_insert_rls on audit_events;
drop policy if exists audit_events_select_rls on audit_events;
create policy audit_events_rls on audit_events
  using (
    organization_id is null
    or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  with check (
    organization_id is null
    or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );
drop index if exists app_users_email_lower_unique_idx;

commit;
