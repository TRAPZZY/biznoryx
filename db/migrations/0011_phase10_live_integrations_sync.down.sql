begin;

drop policy if exists integration_webhook_events_rls on integration_webhook_events;
drop policy if exists integration_sync_runs_rls on integration_sync_runs;
drop policy if exists integration_connections_rls on integration_connections;
drop table if exists integration_webhook_events;
alter table if exists integration_connections drop constraint if exists integration_connections_last_sync_fk;
drop table if exists integration_sync_runs;
drop table if exists integration_connections;
drop type if exists webhook_event_status;
drop type if exists integration_sync_status;
drop type if exists integration_connection_status;
drop type if exists integration_provider_kind;

commit;
