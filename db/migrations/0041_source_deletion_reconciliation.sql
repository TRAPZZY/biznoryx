begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table source_file_deletion_outbox
  add column status text not null default 'pending',
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column available_at timestamptz not null default now(),
  add column last_error_code text;

alter table source_file_deletion_outbox
  add constraint source_deletion_status_valid
  check (status in ('pending','leased','completed','dead'));

create index source_deletion_worker_due_idx
  on source_file_deletion_outbox(available_at, requested_at)
  where completed_at is null;

create function claim_source_file_deletions(p_limit integer)
returns table(
  id uuid,
  organization_id uuid,
  storage_key text,
  lease_token uuid,
  attempts integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'Invalid deletion batch size';
  end if;

  update source_file_deletion_outbox o
  set status = 'dead',
      last_error_code = 'LEASE_EXHAUSTED'
  where o.status = 'leased'
    and o.lease_until < now()
    and o.attempts >= 8
    and o.completed_at is null;

  return query
  with selected as (
    select o.id
    from source_file_deletion_outbox o
    where o.completed_at is null
      and o.attempts < 8
      and (
        (o.status = 'pending' and o.available_at <= now())
        or
        (o.status = 'leased' and o.lease_until < now())
      )
    order by o.requested_at, o.id
    limit p_limit
    for update skip locked
  )
  update source_file_deletion_outbox o
  set status = 'leased',
      lease_token = gen_random_uuid(),
      lease_until = now() + interval '90 seconds',
      attempts = o.attempts + 1,
      last_attempt_at = now()
  from selected
  where o.id = selected.id
  returning
    o.id,
    o.organization_id,
    o.storage_key,
    o.lease_token,
    o.attempts;
end;
$function$;

create function finish_source_file_deletion(
  p_id uuid,
  p_token uuid,
  p_success boolean,
  p_error_code text,
  p_retry_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  affected integer;
begin
  if p_success is null
    or p_retry_seconds is null
    or p_retry_seconds < 0
    or p_retry_seconds > 3600
    or (
      p_error_code is not null
      and p_error_code not in ('STORAGE_ERROR','KEY_REJECTED')
    )
  then
    raise exception 'Invalid deletion acknowledgement';
  end if;

  update source_file_deletion_outbox
  set status = case
      when p_success then 'completed'
      when attempts >= 8 then 'dead'
      else 'pending'
    end,
    completed_at = case
      when p_success then now()
      else completed_at
    end,
    available_at = case
      when p_success then available_at
      else now() + make_interval(secs => greatest(10,p_retry_seconds))
    end,
    lease_token = null,
    lease_until = null,
    last_error_code = case
      when p_success then null
      else coalesce(p_error_code, 'STORAGE_ERROR')
    end
  where id = p_id
    and lease_token = p_token
    and status = 'leased'
    and completed_at is null;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$function$;

revoke all on function claim_source_file_deletions(integer) from public;
revoke all on function finish_source_file_deletion(uuid,uuid,boolean,text,integer) from public;

do $grant$
begin
  if exists (
    select 1 from pg_roles where rolname = 'biznoryx_app'
  ) then
    grant execute on function claim_source_file_deletions(integer)
      to biznoryx_app;

    grant execute on function finish_source_file_deletion(uuid,uuid,boolean,text,integer)
      to biznoryx_app;
  end if;
end;
$grant$;

commit;
