begin;

drop policy if exists audit_events_rls on audit_events;
drop policy if exists organizations_rls on organizations;
drop table if exists audit_events;
drop table if exists organizations;
drop table if exists app_users;

commit;
