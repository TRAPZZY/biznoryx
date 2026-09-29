begin;

create type alert_condition_kind as enum ('sync_failure', 'data_health_attention', 'high_severity_finding');
create type alert_rule_status as enum ('active', 'paused');
create type alert_severity as enum ('low', 'medium', 'high', 'critical');
create type alert_event_status as enum ('open', 'acknowledged', 'resolved');
create type alert_notification_status as enum ('pending', 'sent', 'failed', 'suppressed');

create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null,
  condition_kind alert_condition_kind not null,
  severity alert_severity not null default 'medium',
  status alert_rule_status not null default 'active',
  config jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table alert_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  alert_rule_id uuid not null references alert_rules(id) on delete restrict,
  status alert_event_status not null default 'open',
  severity alert_severity not null,
  title text not null,
  message text not null,
  source_type text not null,
  source_id uuid,
  fingerprint text not null,
  evidence jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  acknowledged_by_user_id uuid references app_users(id),
  acknowledged_at timestamptz,
  resolved_by_user_id uuid references app_users(id),
  resolved_at timestamptz,
  unique (organization_id, alert_rule_id, fingerprint, status)
);

create table alert_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  alert_event_id uuid not null references alert_events(id) on delete restrict,
  channel text not null,
  recipient text not null,
  status alert_notification_status not null default 'pending',
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index alert_rules_org_status_idx on alert_rules(organization_id, status, condition_kind);
create index alert_events_org_status_idx on alert_events(organization_id, status, severity, triggered_at desc);
create index alert_notifications_event_idx on alert_notifications(organization_id, alert_event_id, status);

alter table alert_rules enable row level security;
alter table alert_events enable row level security;
alter table alert_notifications enable row level security;

create policy alert_rules_rls on alert_rules
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy alert_events_rls on alert_events
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create policy alert_notifications_rls on alert_notifications
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

commit;
