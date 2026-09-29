begin;

drop policy if exists forecast_runs_rls on forecast_runs;
drop policy if exists forecast_scenarios_rls on forecast_scenarios;
drop policy if exists forecast_models_rls on forecast_models;
drop table if exists forecast_runs;
drop table if exists forecast_scenarios;
drop table if exists forecast_models;
drop type if exists scenario_status;
drop type if exists forecast_status;
drop type if exists forecast_model_kind;

commit;
