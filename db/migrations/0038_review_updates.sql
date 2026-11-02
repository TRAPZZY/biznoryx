begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
-- Platform release metadata, not tenant-owned business records. Runtime is
-- read-only; an administrator can pilot one organization before broad release.
create table business_review_release (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  pilot_organization_id uuid references organizations(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into business_review_release(singleton,enabled) values(true,false);
revoke all on business_review_release from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='biznoryx_app') then grant select on business_review_release to biznoryx_app; end if;
end $$;
alter table notification_events alter column ingestion_run_id drop not null;
alter table notification_events drop constraint notification_events_kind_check;
alter table notification_events add constraint notification_events_kind_check check(kind in ('report_ready','upload_attention','monthly_review','money_review','mapping_review'));
alter table notification_events add column review_target_id uuid;
alter table notification_events add column review_period text;
alter table notification_events add constraint notification_event_target_check check(
  (kind in ('report_ready','upload_attention') and ingestion_run_id is not null and review_target_id is null)
  or (kind in ('monthly_review','money_review','mapping_review') and ingestion_run_id is null and review_target_id is not null));
create unique index notification_events_review_revision on notification_events(organization_id,kind,source_revision) where review_target_id is not null;
create function enqueue_review_update() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare event_kind text; review_month text;
begin
  if not exists(select 1 from organization_features where organization_id=new.organization_id and feature_key='in_app_updates' and enabled) then return new; end if;
  if tg_table_name='monthly_close_versions' then event_kind:='monthly_review'; review_month:=new.period;
  elsif tg_table_name='money_trail_imports' then event_kind:='money_review';
  else
    if new.version=1 then return new; end if;
    event_kind:='mapping_review';
  end if;
  insert into notification_events(organization_id,kind,source_revision,review_target_id,review_period)
    values(new.organization_id,event_kind,new.id::text,new.id,review_month)
    on conflict do nothing;
  return new;
end;
$$;
revoke all on function enqueue_review_update() from public;
create trigger monthly_review_update after insert on monthly_close_versions for each row execute function enqueue_review_update();
create trigger money_review_update after insert on money_trail_imports for each row execute function enqueue_review_update();
create trigger mapping_review_update after insert on import_profiles for each row execute function enqueue_review_update();
create or replace function deliver_source_updates(p_limit integer default 20) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  event_row notification_events%rowtype;
  delivered integer := 0;
begin
  if p_limit < 1 or p_limit > 100 or p_limit is null then raise exception 'Invalid delivery batch'; end if;
  for event_row in
    select e.* from notification_events e
    join organization_features f on f.organization_id = e.organization_id and f.feature_key = 'in_app_updates' and f.enabled
    join organizations o on o.id = e.organization_id and o.disabled_at is null
    where e.status = 'pending' and e.available_at <= now() order by e.created_at, e.id
    for update of e skip locked limit p_limit
  loop
    begin
      if event_row.evidence_status = 'current' then
        insert into notification_recipients(organization_id, event_id, user_id)
        select event_row.organization_id, event_row.id, m.user_id
        from organization_memberships m join app_users u on u.id = m.user_id and u.disabled_at is null
        where m.organization_id = event_row.organization_id and m.status = 'active'
          and m.role in ('owner', 'admin', 'analyst', 'viewer')
          and m.created_at <= event_row.created_at
          and not exists (select 1 from notification_preferences p where p.organization_id = m.organization_id
            and p.user_id = m.user_id and p.category = case when event_row.kind in ('report_ready','monthly_review') then 'reports' else 'data' end
            and not p.enabled)
        on conflict (event_id, user_id) do nothing;
      end if;
      update notification_events set status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error_code = null where id = event_row.id;
      delivered := delivered + 1;
    exception when others then
      update notification_events set attempts = attempts + 1,
        status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
        available_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts)) + floor(random() * 10)),
        last_error_code = 'DELIVERY_FAILED' where id = event_row.id;
    end;
  end loop;
  return delivered;
end;
$$;

commit;
