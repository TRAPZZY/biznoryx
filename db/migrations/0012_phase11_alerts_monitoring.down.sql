begin;

drop policy if exists alert_notifications_rls on alert_notifications;
drop policy if exists alert_events_rls on alert_events;
drop policy if exists alert_rules_rls on alert_rules;
drop table if exists alert_notifications;
drop table if exists alert_events;
drop table if exists alert_rules;
drop type if exists alert_notification_status;
drop type if exists alert_event_status;
drop type if exists alert_severity;
drop type if exists alert_rule_status;
drop type if exists alert_condition_kind;

commit;
