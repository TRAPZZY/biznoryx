begin;

drop policy if exists dashboard_snapshot_metrics_rls on dashboard_snapshot_metrics;
drop policy if exists dashboard_snapshots_rls on dashboard_snapshots;
drop table if exists dashboard_snapshot_metrics;
drop table if exists dashboard_snapshots;
drop type if exists dashboard_snapshot_status;

commit;
