select set_config('app.bootstrap_runtime_password', :'biznoryx_app_password', false) is not null;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    execute format('create role biznoryx_app login password %L nobypassrls', current_setting('app.bootstrap_runtime_password'));
  else
    execute format('alter role biznoryx_app login password %L nobypassrls', current_setting('app.bootstrap_runtime_password'));
  end if;
end $$;

grant usage on schema public to biznoryx_app;

grant select, insert, update on
  organizations,
  audit_events,
  organization_memberships,
  organization_invitations,
  user_sessions,
  email_verification_challenges,
  business_profiles,
  business_model_entries,
  business_facts,
  business_terms,
  business_goals,
  kpi_definitions,
  data_sources,
  data_streams,
  stream_schema_versions,
  reporting_periods,
  raw_data_objects,
  ingestion_runs,
  ingestion_validation_results,
  semantic_mappings,
  semantic_mapping_fields,
  metric_calculation_specs,
  verified_metric_runs,
  metric_run_validation_results,
  dashboard_snapshots,
  dashboard_snapshot_metrics,
  metric_period_comparisons,
  metric_trend_summaries,
  performance_findings,
  finding_evidence,
  management_actions,
  action_outcomes,
  professional_reports,
  professional_report_sections,
  integration_connections,
  integration_sync_runs,
  integration_webhook_events,
  alert_rules,
  alert_events,
  alert_notifications,
  forecast_models,
  forecast_scenarios,
  forecast_runs,
  organization_plans,
  organization_usage_windows,
  rate_limit_events,
  worker_jobs,
  organization_billing_subscriptions,
  billing_checkout_sessions,
  billing_webhook_events
to biznoryx_app;

grant select on app_users to biznoryx_app;
grant insert, update on app_users to biznoryx_app;
revoke update, delete on audit_events from biznoryx_app;
grant execute on function runtime_active_memberships(uuid) to biznoryx_app;
grant execute on function runtime_session_context(text) to biznoryx_app;
