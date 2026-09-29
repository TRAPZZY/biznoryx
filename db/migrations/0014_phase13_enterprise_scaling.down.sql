begin;

drop policy if exists worker_jobs_rls on worker_jobs;
drop policy if exists rate_limit_events_rls on rate_limit_events;
drop policy if exists organization_usage_windows_rls on organization_usage_windows;
drop policy if exists organization_plans_rls on organization_plans;
drop table if exists worker_jobs;
drop table if exists rate_limit_events;
drop table if exists organization_usage_windows;
drop table if exists organization_plans;
drop type if exists worker_job_status;
drop type if exists worker_job_kind;
drop type if exists rate_limit_decision;
drop type if exists enterprise_usage_kind;
drop type if exists enterprise_plan_status;

commit;
