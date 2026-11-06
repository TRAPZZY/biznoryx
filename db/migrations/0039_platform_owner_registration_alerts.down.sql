begin;
-- DISPOSABLE TEST DATABASES ONLY. Destructively deletes owner alert history.
drop trigger if exists app_users_owner_registration_alert on app_users;
drop function if exists enqueue_platform_owner_registration_alert();
drop function if exists claim_platform_owner_registration_alerts(integer);
drop function if exists finish_platform_owner_registration_alert(uuid,uuid,boolean,text,integer);
drop table if exists platform_owner_registration_alerts;
drop table if exists platform_owner_alert_settings;
commit;
