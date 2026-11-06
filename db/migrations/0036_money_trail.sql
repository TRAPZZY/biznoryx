begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Organization-inclusive ingestion/raw identities are provided by migration 0035.
create table money_trail_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  ingestion_run_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 180),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, ingestion_run_id) references ingestion_runs(organization_id, id)
);

create table money_trail_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  ingestion_run_id uuid not null,
  raw_data_object_id uuid not null,
  source_checksum text not null check (source_checksum ~ '^[a-f0-9]{64}$'),
  source_row_locator text not null check (length(source_row_locator) between 1 and 300),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  record_date date not null check (record_date between date '1900-01-01' and date '2199-12-31'),
  reference text not null check (length(reference) <= 180),
  description text not null check (length(description) <= 2000),
  amount numeric not null check (amount > 0 and amount <= 9999999999999999.99 and scale(amount) <= 2),
  currency text not null default 'NGN' check (currency = 'NGN'),
  source_content jsonb not null,
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, ingestion_run_id, source_row_locator),
  unique (organization_id, source_checksum, source_row_locator),
  foreign key (organization_id, ingestion_run_id) references ingestion_runs(organization_id, id),
  foreign key (organization_id, raw_data_object_id) references raw_data_objects(organization_id, id)
);

-- Mutable concurrency head only; the source and all review events remain immutable.
create table money_trail_record_states (
  organization_id uuid not null references organizations(id),
  record_id uuid not null,
  version integer not null default 1 check (version > 0),
  kind text not null check (kind in ('sale', 'receipt', 'owner_movement', 'unknown', 'credit', 'refund')),
  payment_status text not null check (payment_status in ('unknown', 'confirmed_receivable')),
  due_date date check (due_date between date '1900-01-01' and date '2199-12-31'),
  reference_confirmed boolean not null default false,
  primary key (organization_id, record_id),
  foreign key (organization_id, record_id) references money_trail_records(organization_id, id),
  check (payment_status = 'unknown' or kind = 'sale'),
  check (due_date is null or payment_status = 'confirmed_receivable')
);

create table money_trail_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  record_id uuid not null,
  version integer not null check (version > 0),
  classification jsonb not null,
  reason text not null check (length(reason) between 1 and 1000),
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, record_id, version),
  foreign key (organization_id, record_id) references money_trail_records(organization_id, id)
);

create table money_trail_import_records (
  organization_id uuid not null references organizations(id),
  import_id uuid not null,
  record_id uuid not null,
  primary key (organization_id, import_id, record_id),
  foreign key (organization_id, import_id) references money_trail_imports(organization_id, id),
  foreign key (organization_id, record_id) references money_trail_records(organization_id, id)
);

create table money_trail_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  sale_id uuid not null,
  receipt_id uuid not null,
  amount numeric not null check (amount > 0 and amount <= 9999999999999999.99 and scale(amount) <= 2),
  kind text not null check (kind in ('receipt', 'credit', 'refund')),
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, sale_id) references money_trail_records(organization_id, id),
  foreign key (organization_id, receipt_id) references money_trail_records(organization_id, id),
  check (sale_id <> receipt_id)
);

create table money_trail_reversals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  allocation_id uuid not null,
  reason text not null check (length(reason) between 1 and 1000),
  created_by_user_id uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, allocation_id),
  foreign key (organization_id, allocation_id) references money_trail_allocations(organization_id, id)
);

create table money_trail_source_supersessions (
  organization_id uuid not null references organizations(id),
  previous_ingestion_run_id uuid not null,new_ingestion_run_id uuid not null,
  reason text not null check(length(reason) between 1 and 1000),
  created_by_user_id uuid not null references app_users(id),created_at timestamptz not null default now(),
  primary key(organization_id,previous_ingestion_run_id),unique(organization_id,new_ingestion_run_id),
  foreign key(organization_id,previous_ingestion_run_id) references ingestion_runs(organization_id,id),
  foreign key(organization_id,new_ingestion_run_id) references ingestion_runs(organization_id,id),
  check(previous_ingestion_run_id<>new_ingestion_run_id)
);
create index money_trail_records_period on money_trail_records(organization_id, record_date, id);
create index money_trail_states_review on money_trail_record_states(organization_id, kind, payment_status);
create index money_trail_allocations_sale on money_trail_allocations(organization_id, sale_id);
create index money_trail_allocations_receipt on money_trail_allocations(organization_id, receipt_id);
create index money_trail_imports_run on money_trail_imports(organization_id, ingestion_run_id);

create function money_trail_member(p_org uuid, p_write boolean) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select p_org = nullif(current_setting('app.current_organization_id', true), '')::uuid and exists (
    select 1 from organization_memberships m
    join organizations o on o.id = m.organization_id and o.disabled_at is null
    join app_users u on u.id = m.user_id and u.disabled_at is null
    where m.organization_id = p_org and m.status = 'active' and m.disabled_at is null
      and m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      and (not p_write or m.role in ('owner', 'admin', 'analyst'))
  );
$$;
revoke all on function money_trail_member(uuid, boolean) from public;

do $$
declare table_name text;
begin
  foreach table_name in array array['money_trail_imports', 'money_trail_records', 'money_trail_record_states',
    'money_trail_classifications', 'money_trail_import_records', 'money_trail_allocations', 'money_trail_reversals', 'money_trail_source_supersessions'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format('create policy money_trail_read on %I for select using (money_trail_member(organization_id, false))', table_name);
    execute format('create policy money_trail_insert on %I for insert with check (money_trail_member(organization_id, true))', table_name);
  end loop;
end;
$$;
create policy money_trail_update on money_trail_record_states for update
  using (money_trail_member(organization_id, true)) with check (money_trail_member(organization_id, true));

create function money_trail_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Money Trail evidence is immutable; append a review or reversal' using errcode = '23514';
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['money_trail_imports', 'money_trail_records', 'money_trail_classifications',
    'money_trail_import_records', 'money_trail_allocations', 'money_trail_reversals', 'money_trail_source_supersessions'] loop
    execute format('create trigger money_trail_immutable before update or delete on %I for each row execute function money_trail_immutable()', table_name);
  end loop;
end;
$$;

create function money_trail_state_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.organization_id <> old.organization_id or new.record_id <> old.record_id or new.version <> old.version + 1 then
    raise exception 'Money Trail version conflict' using errcode = '23514';
  end if;
  if row(new.kind, new.payment_status, new.due_date, new.reference_confirmed)
      is distinct from row(old.kind, old.payment_status, old.due_date, old.reference_confirmed) and exists (
    select 1 from money_trail_allocations a where a.organization_id = old.organization_id
      and (a.sale_id = old.record_id or a.receipt_id = old.record_id)
      and not exists (select 1 from money_trail_reversals r where r.organization_id = a.organization_id and r.allocation_id = a.id)
  ) then
    raise exception 'Reverse active allocations before reclassifying' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger money_trail_state_guard before update on money_trail_record_states
  for each row execute function money_trail_state_guard();

-- The database enforces conservation even for a caller bypassing the repository.
-- Every path locks BOTH heads in UUID order before reading allocation sums.
create function money_trail_allocation_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  entry money_trail_allocations%rowtype;
  sale_amount numeric;
  payment_amount numeric;
  sale_kind text;
  payment_kind text;
  paid numeric;
  credited numeric;
  refunded numeric;
  used numeric;
  direction integer := 1;
begin
  if tg_table_name = 'money_trail_reversals' then
    select a.* into entry from money_trail_allocations a where a.organization_id = new.organization_id and a.id = new.allocation_id;
    if not found then raise exception 'Allocation not found' using errcode = '23503'; end if;
    direction := -1;
  else
    entry := new;
  end if;
  perform record_id from money_trail_record_states
    where organization_id = entry.organization_id and record_id in (entry.sale_id, entry.receipt_id)
    order by record_id for update;
  if exists(select 1 from money_trail_records r join money_trail_source_supersessions c on c.organization_id=r.organization_id and c.previous_ingestion_run_id=r.ingestion_run_id
    where r.organization_id=entry.organization_id and r.id in(entry.sale_id,entry.receipt_id)) then
    raise exception 'Superseded source cannot receive financial allocations' using errcode='23514';
  end if;
  select r.amount, s.kind into sale_amount, sale_kind from money_trail_records r
    join money_trail_record_states s on s.organization_id = r.organization_id and s.record_id = r.id
    where r.organization_id = entry.organization_id and r.id = entry.sale_id;
  select r.amount, s.kind into payment_amount, payment_kind from money_trail_records r
    join money_trail_record_states s on s.organization_id = r.organization_id and s.record_id = r.id
    where r.organization_id = entry.organization_id and r.id = entry.receipt_id;
  if sale_kind is distinct from 'sale' or payment_kind is distinct from entry.kind then
    raise exception 'Allocation classifications do not match' using errcode = '23514';
  end if;
  select coalesce(sum(a.amount) filter (where a.kind = 'receipt'), 0),
      coalesce(sum(a.amount) filter (where a.kind = 'credit'), 0),
      coalesce(sum(a.amount) filter (where a.kind = 'refund'), 0)
    into paid, credited, refunded from money_trail_allocations a
    where a.organization_id = entry.organization_id and a.sale_id = entry.sale_id
      and not exists (select 1 from money_trail_reversals r where r.organization_id = a.organization_id and r.allocation_id = a.id);
  select coalesce(sum(a.amount), 0) into used from money_trail_allocations a
    where a.organization_id = entry.organization_id and a.receipt_id = entry.receipt_id
      and not exists (select 1 from money_trail_reversals r where r.organization_id = a.organization_id and r.allocation_id = a.id);
  paid := paid + case when entry.kind = 'receipt' then direction * entry.amount else 0 end;
  credited := credited + case when entry.kind = 'credit' then direction * entry.amount else 0 end;
  refunded := refunded + case when entry.kind = 'refund' then direction * entry.amount else 0 end;
  used := used + direction * entry.amount;
  if used < 0 or used > payment_amount or refunded > paid or paid + credited - refunded > sale_amount
      or paid + credited - refunded < 0 then
    raise exception 'MONEY_TRAIL_OVER_ALLOCATION: allocations must conserve source amounts' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger money_trail_allocation_guard before insert on money_trail_allocations
  for each row execute function money_trail_allocation_guard();
create trigger money_trail_reversal_guard before insert on money_trail_reversals
  for each row execute function money_trail_allocation_guard();

create function money_trail_source_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare previous ingestion_runs; replacement ingestion_runs;
begin
  select * into previous from ingestion_runs where organization_id=new.organization_id and id=new.previous_ingestion_run_id;
  select * into replacement from ingestion_runs where organization_id=new.organization_id and id=new.new_ingestion_run_id;
  if previous.id is null or replacement.id is null or previous.data_stream_id<>replacement.data_stream_id
    or previous.reporting_period_id<>replacement.reporting_period_id or replacement.created_at<=previous.created_at
    or previous.status<>'validated' or replacement.status<>'validated' then
    raise exception 'Financial correction requires a newer validated source in the same series and period' using errcode='23514';
  end if;
  perform s.record_id from money_trail_record_states s join money_trail_records r on r.organization_id=s.organization_id and r.id=s.record_id
    where r.organization_id=new.organization_id and r.ingestion_run_id=new.previous_ingestion_run_id order by s.record_id for update of s;
  if exists(select 1 from money_trail_allocations a join money_trail_records r on r.organization_id=a.organization_id and r.id in(a.sale_id,a.receipt_id)
    where a.organization_id=new.organization_id and r.ingestion_run_id=new.previous_ingestion_run_id
      and not exists(select 1 from money_trail_reversals v where v.organization_id=a.organization_id and v.allocation_id=a.id)) then
    raise exception 'Reverse active allocations before replacing a financial source' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function money_trail_source_guard() from public;
create trigger money_trail_source_guard before insert on money_trail_source_supersessions for each row execute function money_trail_source_guard();

revoke all on function money_trail_immutable(), money_trail_state_guard(), money_trail_allocation_guard() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'biznoryx_app') then
    grant execute on function money_trail_member(uuid, boolean) to biznoryx_app;
    grant select, insert on money_trail_imports, money_trail_records, money_trail_record_states,
      money_trail_classifications, money_trail_import_records, money_trail_allocations, money_trail_reversals, money_trail_source_supersessions to biznoryx_app;
    grant update (version, kind, payment_status, due_date, reference_confirmed) on money_trail_record_states to biznoryx_app;
  end if;
end;
$$;
commit;
