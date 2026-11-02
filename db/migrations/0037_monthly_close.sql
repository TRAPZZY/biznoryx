begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
create table monthly_source_sets (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references organizations(id),
 period text not null check(period ~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'),version integer not null check(version>0),
 confirmed_by_user_id uuid not null references app_users(id),confirmed_at timestamptz not null default now(),
 unique(organization_id,id),unique(organization_id,period,version)
);
create table monthly_required_sources (
 organization_id uuid not null references organizations(id),source_set_id uuid not null,data_stream_id uuid not null,
 primary key(organization_id,source_set_id,data_stream_id),
 foreign key(organization_id,source_set_id) references monthly_source_sets(organization_id,id),
 foreign key(organization_id,data_stream_id) references data_streams(organization_id,id)
);
alter table monthly_source_sets enable row level security;
alter table monthly_source_sets force row level security;
create policy monthly_source_sets_tenant on monthly_source_sets using(organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid) with check(organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);
alter table monthly_required_sources enable row level security;
alter table monthly_required_sources force row level security;
create policy monthly_required_sources_tenant on monthly_required_sources using(organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid) with check(organization_id=nullif(current_setting('app.current_organization_id',true),'')::uuid);
create table monthly_close_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  period text not null check (period ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'),
  version integer not null check (version > 0),
  supersedes_id uuid,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  evidence_manifest jsonb not null check (jsonb_typeof(evidence_manifest) = 'object'),
  limitations jsonb not null check (jsonb_typeof(limitations) = 'array'),
  canonical_payload text not null check (octet_length(canonical_payload) between 1 and 2097152),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (length(idempotency_key) between 1 and 160),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid not null,
  created_by_name text not null check (length(created_by_name) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, period, version),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, supersedes_id) references monthly_close_versions(organization_id, id) on delete restrict,
  foreign key (organization_id, created_by_user_id) references organization_memberships(organization_id, user_id) on delete restrict,
  check (supersedes_id is distinct from id),
  check (canonical_payload::jsonb = jsonb_build_object(
    'schemaVersion', 'biznoryx.monthly-close.v1', 'period', period, 'supersedesId', supersedes_id,
    'report', report, 'evidenceManifest', evidence_manifest, 'limitations', limitations)),
  check (content_hash = encode(digest(convert_to(canonical_payload, 'UTF8'), 'sha256'), 'hex'))
);

create table monthly_close_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  close_id uuid not null,
  supersedes_id uuid,
  approved_by_user_id uuid not null,
  approved_by_name text not null check (length(approved_by_name) between 1 and 200),
  approved_by_role text not null check (approved_by_role in ('owner', 'admin')),
  approved_at timestamptz not null default now(),
  unique (organization_id, close_id),
  unique (organization_id, supersedes_id),
  foreign key (organization_id, close_id) references monthly_close_versions(organization_id, id) on delete restrict,
  foreign key (organization_id, supersedes_id) references monthly_close_approvals(organization_id, close_id) on delete restrict,
  foreign key (organization_id, approved_by_user_id) references organization_memberships(organization_id, user_id) on delete restrict,
  check (supersedes_id is distinct from close_id)
);

create index monthly_close_versions_period_idx on monthly_close_versions(organization_id, period desc, version desc);

alter table monthly_close_versions enable row level security;
alter table monthly_close_versions force row level security;
alter table monthly_close_approvals enable row level security;
alter table monthly_close_approvals force row level security;

create policy monthly_close_versions_tenant_policy on monthly_close_versions
using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy monthly_close_approvals_tenant_policy on monthly_close_approvals
using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create function monthly_close_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Retention/deletion runs must use the existing private administrator path.
  -- No session setting controlled by the app role can bypass this guard.
  if tg_op = 'DELETE' and current_user <> 'biznoryx_app' and exists (
    select 1 from pg_roles where rolname = current_user and rolsuper
  ) then return old; end if;
  raise exception 'Monthly close history is immutable' using errcode = '23514';
end;
$$;
create trigger monthly_source_sets_immutable before update or delete on monthly_source_sets for each row execute function monthly_close_immutable();
create trigger monthly_required_sources_immutable before update or delete on monthly_required_sources for each row execute function monthly_close_immutable();
create trigger monthly_close_version_immutable before update or delete on monthly_close_versions
for each row execute function monthly_close_immutable();
create trigger monthly_close_approval_immutable before update or delete on monthly_close_approvals
for each row execute function monthly_close_immutable();

create function monthly_close_approval_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare packet monthly_close_versions; previous monthly_close_versions; active_id uuid;
begin
  if new.organization_id is distinct from nullif(current_setting('app.current_organization_id', true), '')::uuid
    or new.approved_by_user_id is distinct from nullif(current_setting('app.current_user_id', true), '')::uuid then
    raise exception 'Monthly close approval tenant or actor mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1 from organization_memberships m join app_users u on u.id = m.user_id
    where m.organization_id = new.organization_id and m.user_id = new.approved_by_user_id
      and m.status = 'active' and m.role::text in ('owner', 'admin')
      and m.role::text = new.approved_by_role and left(u.display_name, 200) = new.approved_by_name and u.disabled_at is null
  ) then raise exception 'Named owner or admin approval required' using errcode = '42501'; end if;
  select v.* into packet from monthly_close_versions v where v.organization_id = new.organization_id and v.id = new.close_id;
  if packet.id is null then raise exception 'Monthly close not found' using errcode = '23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended('monthly-close:' || new.organization_id::text || ':' || packet.period, 0));
  if new.supersedes_id is distinct from packet.supersedes_id then raise exception 'Explicit supersession mismatch' using errcode = '23514'; end if;
  select a.close_id into active_id from monthly_close_approvals a
    join monthly_close_versions v on v.organization_id = a.organization_id and v.id = a.close_id
    where a.organization_id = new.organization_id and v.period = packet.period
      and not exists (select 1 from monthly_close_approvals next where next.organization_id = a.organization_id and next.supersedes_id = a.close_id);
  if active_id is distinct from new.supersedes_id then raise exception 'Current approval changed; explicit supersession required' using errcode = '23514'; end if;
  if new.supersedes_id is not null then
    select v.* into previous from monthly_close_versions v where v.organization_id = new.organization_id and v.id = new.supersedes_id;
    if previous.period is distinct from packet.period or previous.version >= packet.version then
      raise exception 'Supersession requires a newer version of the same period' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger monthly_close_approve_guard before insert on monthly_close_approvals
for each row execute function monthly_close_approval_guard();

create function monthly_close_audit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'monthly_close_versions' then
    insert into audit_events(organization_id, actor_user_id, event_type, target_type, target_id, metadata)
    values(new.organization_id, new.created_by_user_id, 'monthly_close.drafted', 'monthly_close', new.id,
      jsonb_build_object('version', new.version, 'period', new.period, 'contentHash', new.content_hash));
  else
    insert into audit_events(organization_id, actor_user_id, event_type, target_type, target_id, metadata)
    values(new.organization_id, new.approved_by_user_id, 'monthly_close.approved', 'monthly_close', new.close_id,
      jsonb_build_object('supersedesId', new.supersedes_id, 'role', new.approved_by_role));
    if new.supersedes_id is not null then
      insert into audit_events(organization_id, actor_user_id, event_type, target_type, target_id, metadata)
      values(new.organization_id, new.approved_by_user_id, 'monthly_close.superseded', 'monthly_close', new.supersedes_id,
        jsonb_build_object('supersededById', new.close_id));
    end if;
  end if;
  return new;
end;
$$;
create trigger monthly_close_version_audit after insert on monthly_close_versions for each row execute function monthly_close_audit();
create trigger monthly_close_approval_audit after insert on monthly_close_approvals for each row execute function monthly_close_audit();

revoke all on function monthly_close_immutable(), monthly_close_approval_guard(), monthly_close_audit() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant select, insert on monthly_source_sets, monthly_required_sources, monthly_close_versions, monthly_close_approvals to biznoryx_app;
  end if;
end;
$$;
commit;
