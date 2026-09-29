begin;

drop policy if exists ingestion_validation_results_rls on ingestion_validation_results;
drop policy if exists ingestion_runs_rls on ingestion_runs;
drop policy if exists raw_data_objects_rls on raw_data_objects;
drop policy if exists reporting_periods_rls on reporting_periods;
drop policy if exists stream_schema_versions_rls on stream_schema_versions;
drop policy if exists data_streams_rls on data_streams;
drop policy if exists data_sources_rls on data_sources;
drop table if exists ingestion_validation_results;
drop table if exists ingestion_runs;
drop table if exists raw_data_objects;
alter table if exists data_streams drop constraint if exists data_streams_active_schema_version_fk;
drop table if exists reporting_periods;
drop table if exists stream_schema_versions;
drop table if exists data_streams;
drop table if exists data_sources;
drop type if exists raw_object_status;
drop type if exists schema_drift_classification;
drop type if exists validation_severity;
drop type if exists ingestion_run_status;
drop type if exists data_stream_grain;
drop type if exists data_source_type;

commit;
