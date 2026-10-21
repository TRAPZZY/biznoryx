begin;

create table organization_features (
  organization_id uuid not null references organizations(id) on delete cascade,
  feature_key text not null check (feature_key = 'in_app_updates'),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (organization_id, feature_key)
);

create unique index ingestion_runs_id_org_updates_idx on ingestion_runs(id, organization_id);

create table notification_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  ingestion_run_id uuid not null,
  kind text not null check (kind in ('report_ready', 'upload_attention')),
  source_revision text not null,
  evidence_status text not null default 'current' check (evidence_status in ('current', 'superseded')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (organization_id, kind, ingestion_run_id),
  unique (id, organization_id),
  foreign key (ingestion_run_id, organization_id) references ingestion_runs(id, organization_id) on delete cascade
);

create table notification_recipients (
  organization_id uuid not null references organizations(id) on delete cascade,
  event_id uuid not null,
  user_id uuid not null references app_users(id) on delete cascade,
  read_at timestamptz,
  snoozed_until timestamptz,
  primary key (event_id, user_id),
  foreign key (event_id, organization_id) references notification_events(id, organization_id) on delete cascade
);

create table notification_preferences (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  category text not null check (category in ('reports', 'data')),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, category)
);

create index notification_events_pending_idx on notification_events(available_at, created_at) where status = 'pending';
create index notification_events_org_idx on notification_events(organization_id, created_at desc, id desc);
create index notification_recipients_user_idx on notification_recipients(organization_id, user_id, event_id);

create function updates_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from organization_memberships m
    join organizations o on o.id = m.organization_id and o.disabled_at is null
    join app_users u on u.id = m.user_id and u.disabled_at is null
    where m.organization_id = p_org and m.status = 'active'
      and m.role in ('owner', 'admin', 'analyst', 'viewer')
      and m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      and p_org = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );
$$;
revoke all on function updates_member(uuid) from public;

alter table organization_features enable row level security;
alter table notification_events enable row level security;
alter table notification_recipients enable row level security;
alter table notification_preferences enable row level security;

create policy organization_features_read on organization_features for select using (updates_member(organization_id));
create policy notification_events_read on notification_events for select using (
  updates_member(organization_id) and exists (
    select 1 from notification_recipients r where r.event_id = notification_events.id and r.organization_id = notification_events.organization_id
      and r.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  )
);
create policy notification_recipients_scope on notification_recipients using (
  updates_member(organization_id) and user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
) with check (
  updates_member(organization_id) and user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
);
create policy notification_preferences_scope on notification_preferences using (
  updates_member(organization_id) and user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
) with check (
  updates_member(organization_id) and user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
);

create function enqueue_source_update() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  run_row ingestion_runs%rowtype;
  event_kind text;
  revision text;
begin
  if not exists (select 1 from organization_features where organization_id = new.organization_id
    and feature_key = 'in_app_updates' and enabled) then return new; end if;
  if tg_table_name = 'ingestion_runs' then
    if new.status <> 'rejected' then return new; end if;
    run_row := new;
    event_kind := 'upload_attention';
    revision := new.id::text;
  else
    if new.status <> 'succeeded' or new.job_type <> 'ingestion.verify_storage' then return new; end if;
    select * into run_row from ingestion_runs where id = new.ingestion_run_id and organization_id = new.organization_id;
    if not found or run_row.status <> 'validated' or not exists (
      select 1 from verified_metric_points where organization_id = new.organization_id and ingestion_run_id = run_row.id
    ) then return new; end if;
    event_kind := 'report_ready';
    revision := new.id::text;
  end if;
  -- Serialize corrections for the same stream/period, including out-of-order workers.
  perform pg_advisory_xact_lock(hashtextextended(run_row.organization_id::text || ':' || run_row.reporting_period_id::text, 0));
  insert into notification_events(organization_id, ingestion_run_id, kind, source_revision)
    values (run_row.organization_id, run_row.id, event_kind, revision)
    on conflict (organization_id, kind, ingestion_run_id) do nothing;
  if event_kind = 'report_ready' then
    update notification_events e set evidence_status = 'superseded'
    from ingestion_runs older
    where older.id = e.ingestion_run_id and older.organization_id = e.organization_id
      and e.organization_id = run_row.organization_id and older.data_stream_id = run_row.data_stream_id
      and older.reporting_period_id = run_row.reporting_period_id and older.id <> run_row.id
      and (older.created_at, older.id) < (run_row.created_at, run_row.id);
    if exists (
      select 1 from ingestion_runs newer join notification_events e on e.ingestion_run_id = newer.id
      and e.organization_id = newer.organization_id and e.kind = 'report_ready'
      where newer.organization_id = run_row.organization_id and newer.data_stream_id = run_row.data_stream_id
      and newer.reporting_period_id = run_row.reporting_period_id
      and (newer.created_at, newer.id) > (run_row.created_at, run_row.id)
    ) then
      update notification_events set evidence_status = 'superseded'
        where organization_id = run_row.organization_id and ingestion_run_id = run_row.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function enqueue_source_update() from public;

create trigger ingestion_update_event after insert or update of status on ingestion_runs
  for each row execute function enqueue_source_update();
create trigger processing_update_event after update of status on processing_jobs
  for each row execute function enqueue_source_update();

create function deliver_source_updates(p_limit integer default 20) returns integer
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
            and p.user_id = m.user_id and p.category = case when event_row.kind = 'report_ready' then 'reports' else 'data' end
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
revoke all on function deliver_source_updates(integer) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant execute on function updates_member(uuid), deliver_source_updates(integer) to biznoryx_app;
    grant select on organization_features, notification_events, notification_recipients, notification_preferences to biznoryx_app;
    grant update (read_at, snoozed_until) on notification_recipients to biznoryx_app;
    grant insert, update on notification_preferences to biznoryx_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'biznoryx_worker') then
    grant execute on function deliver_source_updates(integer) to biznoryx_worker;
  end if;
end $$;

commit;
