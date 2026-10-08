begin;

create unique index manual_stream_org_identity on data_streams(organization_id, id);

create table manual_entry_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null,
  period text not null check (period ~ '^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])$'),
  version integer not null default 1 check (version > 0),
  columns jsonb not null check (jsonb_typeof(columns) = 'array'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  entry_date date,
  correction_of uuid,
  validated_version integer,
  validation_id uuid,
  created_by_user_id uuid not null references app_users(id),
  updated_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, data_stream_id) references data_streams(organization_id, id),
  check (entry_date is null or to_char(entry_date, 'YYYY-MM') = period)
);

create table manual_entry_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null,
  draft_id uuid not null,
  draft_version integer not null check (draft_version > 0),
  period text not null,
  batch_id uuid not null,
  revision integer not null check (revision > 0),
  correction_of uuid,
  columns jsonb not null,
  rows jsonb not null,
  entry_date date,
  snapshot_rows jsonb not null,
  snapshot_csv text not null check (octet_length(snapshot_csv) between 1 and 26214400),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  file_name text not null,
  data_status text not null default 'partial' check (data_status = 'partial'),
  submitted_by_user_id uuid not null references app_users(id),
  submitted_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, draft_id, draft_version),
  unique (organization_id, batch_id, revision),
  foreign key (organization_id, data_stream_id) references data_streams(organization_id, id),
  foreign key (organization_id, draft_id) references manual_entry_drafts(organization_id, id),
  foreign key (organization_id, correction_of) references manual_entry_submissions(organization_id, id)
);
alter table manual_entry_drafts add foreign key (organization_id, correction_of)
  references manual_entry_submissions(organization_id, id);

create table manual_entry_deliveries (
  submission_id uuid primary key,
  organization_id uuid not null references organizations(id),
  ingestion_run_id uuid unique references ingestion_runs(id),
  upload jsonb,
  delivered_at timestamptz,
  foreign key (organization_id, submission_id) references manual_entry_submissions(organization_id, id),
  check ((ingestion_run_id is null and upload is null and delivered_at is null)
    or (ingestion_run_id is not null and upload is not null and delivered_at is not null))
);

create table manual_entry_period_sources (
  organization_id uuid not null references organizations(id),
  data_stream_id uuid not null,
  period text not null,
  input_mode text not null check (input_mode in ('manual_entry', 'full_file')),
  created_at timestamptz not null default now(),
  primary key (organization_id, data_stream_id, period),
  foreign key (organization_id, data_stream_id) references data_streams(organization_id, id)
);

alter table ingestion_runs add column manual_submission_id uuid unique;
alter table ingestion_runs add foreign key (organization_id, manual_submission_id)
  references manual_entry_submissions(organization_id, id);
alter table ingestion_runs add column data_status text not null default 'complete'
  check (data_status in ('complete', 'partial'));
alter table reporting_periods add column data_status text not null default 'complete'
  check (data_status in ('complete', 'partial'));

create index manual_drafts_org_updated on manual_entry_drafts(organization_id, updated_at desc);
create index manual_submissions_ledger on manual_entry_submissions(organization_id, data_stream_id, period, batch_id, revision desc);

alter table manual_entry_drafts enable row level security;
alter table manual_entry_drafts force row level security;
create policy manual_entry_drafts_tenant on manual_entry_drafts
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
alter table manual_entry_submissions enable row level security;
alter table manual_entry_submissions force row level security;
create policy manual_entry_submissions_tenant on manual_entry_submissions
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
alter table manual_entry_deliveries enable row level security;
alter table manual_entry_deliveries force row level security;
create policy manual_entry_deliveries_tenant on manual_entry_deliveries
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
alter table manual_entry_period_sources enable row level security;
alter table manual_entry_period_sources force row level security;
create policy manual_entry_period_sources_tenant on manual_entry_period_sources
  using (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

create function manual_entry_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Manual submission evidence is immutable' using errcode = '23514';
end;
$$;
create trigger manual_submission_immutable before update or delete on manual_entry_submissions
  for each row execute function manual_entry_immutable();

create function claim_ingestion_period_source(p_org uuid, p_stream uuid, p_period text, p_mode text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare existing_mode text;
begin
  if p_org is distinct from nullif(current_setting('app.current_organization_id', true), '')::uuid then
    raise exception 'Tenant context mismatch' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_stream::text || ':' || p_period, 0));
  -- Account for runs created before this migration, not just new reservations.
  if p_mode = 'manual_entry' and exists (
    select 1 from ingestion_runs ir join reporting_periods rp on rp.id = ir.reporting_period_id
    where ir.organization_id = p_org and ir.data_stream_id = p_stream
      and to_char(rp.period_start, 'YYYY-MM') = p_period and ir.manual_submission_id is null
      and ir.status in ('validated', 'pending')
  ) then
    raise exception 'SOURCE_MODE_CONFLICT: this period contains full-file data' using errcode = '23514';
  end if;
  insert into manual_entry_period_sources(organization_id, data_stream_id, period, input_mode)
    values(p_org, p_stream, p_period, p_mode) on conflict do nothing;
  select input_mode into existing_mode from manual_entry_period_sources
    where organization_id = p_org and data_stream_id = p_stream and period = p_period;
  if existing_mode is distinct from p_mode then
    raise exception 'SOURCE_MODE_CONFLICT: explicit source resolution is required' using errcode = '23514';
  end if;
end;
$$;

create function enforce_manual_ingestion_source() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare period_label text;
begin
  if tg_op = 'UPDATE' then
    if new.manual_submission_id is distinct from old.manual_submission_id or new.data_status is distinct from old.data_status
      or new.data_stream_id is distinct from old.data_stream_id or new.reporting_period_id is distinct from old.reporting_period_id
      or new.raw_data_object_id is distinct from old.raw_data_object_id or new.organization_id is distinct from old.organization_id then
      raise exception 'Ingestion source identity is immutable' using errcode = '23514';
    end if;
  end if;
  select to_char(period_start, 'YYYY-MM') into period_label from reporting_periods
    where id = new.reporting_period_id and organization_id = new.organization_id and data_stream_id = new.data_stream_id;
  if period_label is null then raise exception 'Reporting period tenant mismatch' using errcode = '23514'; end if;
  if new.status = 'rejected' then return new; end if;
  perform claim_ingestion_period_source(new.organization_id, new.data_stream_id, period_label,
    case when new.manual_submission_id is null then 'full_file' else 'manual_entry' end);
  if new.manual_submission_id is not null then
    if not exists (
      select 1 from manual_entry_submissions s join raw_data_objects r on r.id = new.raw_data_object_id
      where s.id = new.manual_submission_id and s.organization_id = new.organization_id
        and s.data_stream_id = new.data_stream_id and s.period = period_label
        and r.organization_id = s.organization_id and r.checksum_sha256 = s.checksum_sha256
    ) then raise exception 'Manual snapshot lineage mismatch' using errcode = '23514'; end if;
    new.data_status := 'partial';
    update reporting_periods set data_status = 'partial' where id = new.reporting_period_id;
  end if;
  return new;
end;
$$;
create trigger manual_ingestion_source_guard before insert or update on ingestion_runs
  for each row execute function enforce_manual_ingestion_source();

revoke all on function claim_ingestion_period_source(uuid, uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant select, insert, update on manual_entry_drafts, manual_entry_deliveries to biznoryx_app;
    grant select, insert on manual_entry_submissions, manual_entry_period_sources to biznoryx_app;
    grant execute on function claim_ingestion_period_source(uuid, uuid, text, text) to biznoryx_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'biznoryx_worker') then
    grant select on manual_entry_submissions, manual_entry_deliveries, manual_entry_period_sources to biznoryx_worker;
  end if;
end;
$$;

commit;
