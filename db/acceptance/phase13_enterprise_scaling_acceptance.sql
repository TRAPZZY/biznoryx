set client_min_messages to warning;
\set ON_ERROR_STOP on

begin;

insert into app_users (id, email, display_name, password_hash)
values
  ('00000000-0000-4000-8000-000000000131', 'phase13-owner@example.com', 'Phase 13 Owner', 'test-hash'),
  ('00000000-0000-4000-8000-000000000132', 'phase13-other@example.com', 'Phase 13 Other', 'test-hash');

insert into organizations (id, name, slug, created_by_user_id)
values
  ('10000000-0000-4000-8000-000000000131', 'Phase 13 Acme', 'phase13-acme', '00000000-0000-4000-8000-000000000131'),
  ('10000000-0000-4000-8000-000000000132', 'Phase 13 Beta', 'phase13-beta', '00000000-0000-4000-8000-000000000132');

insert into organization_memberships (id, organization_id, user_id, role, status)
values
  ('20000000-0000-4000-8000-000000000131', '10000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000131', 'owner', 'active'),
  ('20000000-0000-4000-8000-000000000132', '10000000-0000-4000-8000-000000000132', '00000000-0000-4000-8000-000000000132', 'owner', 'active');

set local role biznoryx_app;
set local app.current_user_id = '00000000-0000-4000-8000-000000000131';
set local app.current_organization_id = '10000000-0000-4000-8000-000000000131';

insert into organization_plans (
  id,
  organization_id,
  name,
  status,
  limits,
  created_by_user_id,
  updated_by_user_id
) values (
  '30000000-0000-4000-8000-000000000131',
  '10000000-0000-4000-8000-000000000131',
  'Scale',
  'active',
  '{"monthlyForecastRuns":2,"maxConcurrentJobs":1,"maxWorkerLeaseMinutes":5}'::jsonb,
  '00000000-0000-4000-8000-000000000131',
  '00000000-0000-4000-8000-000000000131'
);

insert into organization_usage_windows (
  id,
  organization_id,
  usage_kind,
  window_start,
  window_end,
  used_quantity
) values (
  '40000000-0000-4000-8000-000000000131',
  '10000000-0000-4000-8000-000000000131',
  'forecast_run',
  '2027-02-01',
  '2027-02-28',
  2
);

insert into rate_limit_events (
  id,
  organization_id,
  actor_user_id,
  usage_kind,
  operation_key,
  quantity,
  limit_quantity,
  used_quantity,
  decision
) values (
  '50000000-0000-4000-8000-000000000131',
  '10000000-0000-4000-8000-000000000131',
  '00000000-0000-4000-8000-000000000131',
  'forecast_run',
  'forecast-3',
  1,
  2,
  2,
  'blocked'
);

insert into worker_jobs (
  id,
  organization_id,
  job_kind,
  idempotency_key,
  status,
  payload,
  lease_owner,
  lease_expires_at,
  attempts,
  created_by_user_id
) values (
  '60000000-0000-4000-8000-000000000131',
  '10000000-0000-4000-8000-000000000131',
  'forecast',
  'forecast-job-1',
  'leased',
  '{"forecastModelId":"model-1"}'::jsonb,
  'worker-a',
  now() + interval '5 minutes',
  1,
  '00000000-0000-4000-8000-000000000131'
);

do $$
declare
  visible_plans integer;
  visible_windows integer;
  visible_events integer;
  visible_jobs integer;
begin
  select count(*) into visible_plans from organization_plans;
  select count(*) into visible_windows from organization_usage_windows;
  select count(*) into visible_events from rate_limit_events;
  select count(*) into visible_jobs from worker_jobs;
  if visible_plans <> 1 or visible_windows <> 1 or visible_events <> 1 or visible_jobs <> 1 then
    raise exception 'unexpected enterprise visibility plans=% windows=% events=% jobs=%', visible_plans, visible_windows, visible_events, visible_jobs;
  end if;
end $$;

do $$
begin
  begin
    insert into worker_jobs (
      organization_id,
      job_kind,
      idempotency_key,
      payload,
      created_by_user_id
    ) values (
      '10000000-0000-4000-8000-000000000132',
      'forecast',
      'cross-tenant-job',
      '{}'::jsonb,
      '00000000-0000-4000-8000-000000000131'
    );
    raise exception 'expected cross-tenant worker job insert to fail';
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

reset app.current_organization_id;
reset app.current_user_id;

do $$
declare
  visible_jobs integer;
begin
  select count(*) into visible_jobs from worker_jobs;
  if visible_jobs <> 0 then
    raise exception 'expected default-deny for worker jobs, got %', visible_jobs;
  end if;
end $$;

rollback;
