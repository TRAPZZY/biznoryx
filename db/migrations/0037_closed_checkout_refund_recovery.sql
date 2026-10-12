begin;
create table closed_checkout_refund_recovery (
  reference text primary key,
  organization_id uuid not null,
  encrypted_state jsonb not null,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create function runtime_save_closed_checkout(p_org uuid,p_reference text,p_state jsonb,p_completed boolean,p_next timestamptz)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reference !~ '^bnx_trial_[a-zA-Z0-9_-]+$' or not exists(select 1 from account_deletion_requests
    where p_org = any(closing_organizations)) then raise exception 'Workspace closure is not authorized' using errcode='42501'; end if;
  insert into closed_checkout_refund_recovery(reference,organization_id,encrypted_state,completed_at,next_attempt_at)
    values(p_reference,p_org,p_state,case when p_completed then now() end,p_next)
    on conflict(reference) do update set encrypted_state=excluded.encrypted_state,
      completed_at=coalesce(closed_checkout_refund_recovery.completed_at,excluded.completed_at),next_attempt_at=excluded.next_attempt_at
    where closed_checkout_refund_recovery.organization_id=p_org;
end;
$$;
create function runtime_closed_checkout(p_reference text)
returns table(organization_id uuid,encrypted_state jsonb) language sql security definer set search_path = public, pg_temp stable as $$
  select r.organization_id,r.encrypted_state from closed_checkout_refund_recovery r where r.reference=p_reference;
$$;
create function runtime_pending_closed_checkouts()
returns table(reference text,organization_id uuid) language sql security definer set search_path = public, pg_temp stable as $$
  select r.reference,r.organization_id from closed_checkout_refund_recovery r
    where r.completed_at is null and r.next_attempt_at <= now() order by r.next_attempt_at limit 100;
$$;
revoke all on function runtime_save_closed_checkout(uuid,text,jsonb,boolean,timestamptz),runtime_closed_checkout(text),runtime_pending_closed_checkouts() from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='biznoryx_app') then
    grant execute on function runtime_save_closed_checkout(uuid,text,jsonb,boolean,timestamptz),runtime_closed_checkout(text),runtime_pending_closed_checkouts() to biznoryx_app;
  end if;
end $$;
commit;
