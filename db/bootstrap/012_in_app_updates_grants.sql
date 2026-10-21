grant execute on function updates_member(uuid), deliver_source_updates(integer) to biznoryx_app;
grant select on organization_features, notification_events, notification_recipients, notification_preferences to biznoryx_app;
grant update (read_at, snoozed_until) on notification_recipients to biznoryx_app;
grant insert, update on notification_preferences to biznoryx_app;
