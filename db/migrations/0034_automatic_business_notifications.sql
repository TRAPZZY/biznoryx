begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create function initialize_business_notifications() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.disabled_at is null then
    insert into organization_features(organization_id, feature_key, enabled)
      values (new.id, 'in_app_updates', true)
      on conflict (organization_id, feature_key) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function initialize_business_notifications() from public;

create trigger organization_notification_defaults after insert on organizations
  for each row execute function initialize_business_notifications();

insert into organization_features(organization_id, feature_key, enabled)
select id, 'in_app_updates', true from organizations where disabled_at is null
on conflict (organization_id, feature_key)
do update set enabled = true, updated_at = now()
where not organization_features.enabled;

commit;
