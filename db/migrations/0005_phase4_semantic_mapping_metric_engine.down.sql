begin;

drop policy if exists metric_run_validation_results_rls on metric_run_validation_results;
drop policy if exists verified_metric_runs_rls on verified_metric_runs;
drop policy if exists metric_calculation_specs_rls on metric_calculation_specs;
drop policy if exists semantic_mapping_fields_rls on semantic_mapping_fields;
drop policy if exists semantic_mappings_rls on semantic_mappings;
drop table if exists metric_run_validation_results;
drop table if exists verified_metric_runs;
drop table if exists metric_calculation_specs;
drop table if exists semantic_mapping_fields;
drop table if exists semantic_mappings;
drop type if exists metric_run_status;
drop type if exists metric_operation;
drop type if exists semantic_field_type;
drop type if exists semantic_mapping_status;

commit;
