begin;

create table account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app_users(id),
  receipt_hash text not null unique check (length(receipt_hash) = 64),
  contact_email text,
  closing_organizations uuid[] not null default '{}',
  status text not null default 'queued' check (status in ('queued','purging','completed','attention')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table account_deletion_requests enable row level security;
create policy account_deletion_self on account_deletion_requests for select
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

create function runtime_account_deletion_context(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  if p_user is distinct from nullif(current_setting('app.current_user_id', true), '')::uuid then
    raise exception 'Account context mismatch' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role,
    'lastOwner', m.role = 'owner' and not exists (select 1 from organization_memberships other
      where other.organization_id = o.id and other.user_id <> p_user and other.role = 'owner' and other.status = 'active'),
    'members', case when m.role = 'owner' then (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name)), '[]')
      from organization_memberships other join app_users u on u.id = other.user_id
      where other.organization_id = o.id and other.user_id <> p_user and other.status = 'active' and u.disabled_at is null)
      else '[]'::jsonb end)), '[]') into result
    from organization_memberships m join organizations o on o.id = m.organization_id
    where m.user_id = p_user and m.status = 'active' and o.disabled_at is null;
  return jsonb_build_object('organizations', result);
end;
$$;

create function runtime_request_account_deletion(p_user uuid, p_receipt text, p_transfers jsonb, p_close boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare item record; replacement uuid; closing uuid[] := '{}'; job_id uuid; account_email text;
begin
  if p_user is distinct from nullif(current_setting('app.current_user_id', true), '')::uuid
    or p_receipt is null or p_receipt !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_transfers) is distinct from 'object' then
    raise exception 'Invalid deletion request' using errcode = '42501';
  end if;
  select email into account_email from app_users where id = p_user and disabled_at is null for update;
  if not found then raise exception 'Account is unavailable' using errcode = '42501'; end if;
  for item in select o.id, m.role from organizations o join organization_memberships m on m.organization_id = o.id
    where m.user_id = p_user and m.status = 'active' and o.disabled_at is null order by o.id for update of o
  loop
    if item.role = 'owner' and not exists (select 1 from organization_memberships
      where organization_id = item.id and user_id <> p_user and role = 'owner' and status = 'active') then
      replacement := nullif(p_transfers->>item.id::text, '')::uuid;
      if replacement is not null then
        update organization_memberships m set role = 'owner', updated_at = now()
          where m.organization_id = item.id and m.user_id = replacement and m.user_id <> p_user and m.status = 'active'
            and exists (select 1 from app_users u where u.id = m.user_id and u.disabled_at is null);
        if not found then raise exception 'Replacement owner is unavailable' using errcode = '42501'; end if;
      else
        if not p_close then raise exception 'Confirm workspace closure or transfer ownership' using errcode = '23514'; end if;
        closing := array_append(closing, item.id);
        update organizations set disabled_at = now(), updated_at = now() where id = item.id;
        update organization_memberships set status = 'disabled', disabled_at = now(), updated_at = now() where organization_id = item.id;
        update processing_jobs set status = 'dead', last_error = 'Workspace closure requested', updated_at = now()
          where organization_id = item.id and status in ('queued','failed');
      end if;
    end if;
  end loop;
  insert into account_deletion_requests(user_id, receipt_hash, contact_email, closing_organizations)
    values(p_user, p_receipt, account_email, closing) returning id into job_id;
  update app_users set disabled_at = now(), updated_at = now() where id = p_user;
  update user_sessions set revoked_at = now() where user_id = p_user;
  update organization_memberships set status = 'disabled', disabled_at = now(), updated_at = now() where user_id = p_user;
  return job_id;
end;
$$;

create function runtime_account_deletion_status(p_receipt text)
returns jsonb language sql security definer set search_path = public, pg_temp stable as $$
  select jsonb_build_object('status', status, 'requestedAt', requested_at, 'completedAt', completed_at)
    from account_deletion_requests where receipt_hash = p_receipt;
$$;

create function runtime_pending_account_deletions()
returns setof account_deletion_requests language sql security definer set search_path = public, pg_temp stable as $$
  select r.* from account_deletion_requests r where status in ('queued','purging') and next_attempt_at <= now()
    order by requested_at limit 20;
$$;

create function runtime_account_deletion_retry(p_job uuid, p_error text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update account_deletion_requests set attempts = attempts + 1,
    status = case when attempts >= 9 then 'attention' else 'queued' end,
    next_attempt_at = now() + least(3600, 30 * power(2, least(attempts, 7))) * interval '1 second',
    last_error_code = left(p_error, 80)
  where id = p_job and status <> 'completed';
$$;

-- The caller cannot mutate evidence. Only the table owner's deletion finalizer,
-- executing an approved closed-workspace request, can remove immutable records.
create or replace function manual_entry_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_user = (select pg_get_userbyid(relowner) from pg_class where oid = tg_relid)
    and exists (select 1 from account_deletion_requests r join organizations o on o.id = any(r.closing_organizations)
      where o.id = old.organization_id and o.disabled_at is not null and r.status = 'purging') then
    return old;
  end if;
  raise exception 'Manual submission evidence is immutable' using errcode = '23514';
end;
$$;

create function runtime_finish_account_deletion(p_job uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare job account_deletion_requests; org uuid; item record; tables text[]; remaining text[]; progress boolean;
begin
  select r.* into job from account_deletion_requests r where id = p_job for update;
  if not found or job.status = 'completed' then return; end if;
  if not exists (select 1 from app_users where id = job.user_id and disabled_at is not null) then
    raise exception 'Deletion was not authorized' using errcode = '42501';
  end if;
  update account_deletion_requests set status = 'purging' where id = p_job;
  foreach org in array job.closing_organizations loop
    perform set_config('app.current_organization_id', org::text, true);
    if not exists (select 1 from organizations where id = org and disabled_at is not null) then
      raise exception 'Workspace is still active' using errcode = '42501';
    end if;
    if exists (select 1 from processing_jobs where organization_id = org and status = 'leased' and lease_expires_at > now()) then
      raise exception 'Workspace processing is still finishing' using errcode = '55000';
    end if;
    update user_sessions set active_organization_id = null, revoked_at = now() where active_organization_id = org;
    update data_streams set active_schema_version_id = null where organization_id = org;
    update integration_connections set last_sync_run_id = null where organization_id = org;
    update manual_entry_drafts set correction_of = null where organization_id = org;
    if to_regclass('public.store_billing_transactions') is not null then
      execute 'insert into retired_store_transactions(transaction_hash) select transaction_hash from store_billing_transactions where organization_id=$1 on conflict do nothing' using org;
    end if;
    -- Every discovered relation is a public tenant table; quote identifiers and
    -- constrain every deletion by the approved organization, never by a supplied table.
    select array_agg(c.table_name) into tables from information_schema.columns c join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
        and c.table_name <> 'closed_checkout_refund_recovery';
    while cardinality(tables) > 0 loop
      remaining := '{}'; progress := false;
      for item in select unnest(tables) as name loop
        begin
          execute format('delete from public.%I where organization_id = $1', item.name) using org;
          progress := true;
        exception when foreign_key_violation or restrict_violation then remaining := array_append(remaining, item.name);
        end;
      end loop;
      if not progress then raise exception 'Workspace dependencies prevented deletion' using errcode = '55000'; end if;
      tables := remaining;
    end loop;
    delete from organizations where id = org;
  end loop;
  delete from user_sessions where user_id = job.user_id;
  delete from email_verification_challenges where user_id = job.user_id;
  delete from organization_invitations where lower(email) = lower(job.contact_email);
  delete from organization_memberships where user_id = job.user_id;
  delete from audit_events where actor_user_id = job.user_id and organization_id is null;
  -- A non-identifying actor tombstone preserves other members' company lineage.
  update app_users set email = 'deleted-' || id::text || '@example.invalid', display_name = 'Deleted account',
    password_hash = encode(gen_random_bytes(64), 'hex'), email_verified_at = null, updated_at = now() where id = job.user_id;
  update account_deletion_requests set status = 'completed', contact_email = null,
    last_error_code = null, completed_at = now() where id = p_job;
end;
$$;

revoke all on function runtime_account_deletion_context(uuid), runtime_request_account_deletion(uuid,text,jsonb,boolean),
  runtime_account_deletion_status(text), runtime_pending_account_deletions(), runtime_account_deletion_retry(uuid,text),
  runtime_finish_account_deletion(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant select on account_deletion_requests to biznoryx_app;
    grant execute on function runtime_account_deletion_context(uuid), runtime_request_account_deletion(uuid,text,jsonb,boolean),
      runtime_account_deletion_status(text), runtime_pending_account_deletions(), runtime_account_deletion_retry(uuid,text),
      runtime_finish_account_deletion(uuid) to biznoryx_app;
  end if;
end $$;

commit;
