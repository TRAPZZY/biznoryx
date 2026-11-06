begin;
drop trigger if exists organization_notification_defaults on organizations;
drop function if exists initialize_business_notifications();
-- Stop future initialization without deleting notification history or changing existing flags.
commit;
