begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Private platform events. Not part of any tenant-facing Updates inbox.
-- A separate administrator decision is required before collection begins.
create table platform_owner_alert_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into platform_owner_alert_settings(singleton, enabled) values (true, false);
revoke all on platform_owner_alert_settings from public;

create table platform_owner_registration_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app_users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','delivered','dead')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
revoke all on platform_owner_registration_alerts from public;
create index platform_owner_registration_alerts_due_idx on platform_owner_registration_alerts(available_at,created_at)
  where status in ('pending','sending');

-- Trigger fires in the same transaction that verifies the email. Rollbacks
-- roll back the event; already-verified users never produce a new event.
create function enqueue_platform_owner_registration_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.email_verified_at is null and new.email_verified_at is not null
    and exists (select 1 from platform_owner_alert_settings where singleton and enabled)
  then
    insert into platform_owner_registration_alerts(user_id, created_at)
      values (new.id, now()) on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function enqueue_platform_owner_registration_alert() from public;
create trigger app_users_owner_registration_alert
  after update of email_verified_at on app_users
  for each row execute function enqueue_platform_owner_registration_alert();

-- Lease a small batch of platform events; tokens prevent stale workers
-- acknowledging a newer claim. Expired fifth attempts become dead.
create function claim_platform_owner_registration_alerts(p_limit integer)
returns table(event_id uuid, claim_token uuid, occurred_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'Invalid owner-alert batch';
  end if;
  update platform_owner_registration_alerts a set
    status = 'dead', last_error_code = 'LEASE_EXPIRED'
  where a.status = 'sending' and a.lease_until < now() and a.attempts >= 5;
  return query
    with selected as (
      select a.id from platform_owner_registration_alerts a
      where (a.status = 'pending' and a.available_at <= now())
        or (a.status = 'sending' and a.lease_until < now() and a.attempts < 5)
      order by a.created_at, a.id
      for update skip locked
      limit p_limit
    )
    update platform_owner_registration_alerts a set
      status = 'sending',
      attempts = a.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_until = now() + interval '90 seconds'
    from selected where a.id = selected.id
    returning a.id, a.lease_token, a.created_at;
end;
$$;
revoke all on function claim_platform_owner_registration_alerts(integer) from public;

create function finish_platform_owner_registration_alert(p_id uuid, p_claim uuid, p_sent boolean, p_code text, p_retry_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare updated integer;
begin
  if p_sent is null or p_retry_seconds is null or p_retry_seconds < 0 or p_retry_seconds > 3600
    or (p_code is not null and p_code not in ('TELEGRAM_TIMEOUT','TELEGRAM_RATE_LIMIT','TELEGRAM_HTTP','TELEGRAM_REJECTED','DELIVERY_EXCEPTION'))
  then raise exception 'Invalid owner-alert result'; end if;
  update platform_owner_registration_alerts set
    status = case when p_sent then 'delivered' when attempts >= 5 then 'dead' else 'pending' end,
    delivered_at = case when p_sent then now() else null end,
    available_at = case when p_sent then available_at else now() + make_interval(secs => greatest(10,p_retry_seconds)) end,
    lease_token = null, lease_until = null,
    last_error_code = case when p_sent then null else coalesce(p_code,'DELIVERY_EXCEPTION') end
  where id = p_id and lease_token = p_claim and status = 'sending';
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;
revoke all on function finish_platform_owner_registration_alert(uuid,uuid,boolean,text,integer) from public;

-- Execute rights are intentionally not granted to PUBLIC or a guessed
-- application identity. The operator must identify and approve the
-- worker's actual NO-BYPASSRLS database role during activation.
commit;
