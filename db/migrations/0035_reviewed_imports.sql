begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create unique index ingestion_runs_org_identity on ingestion_runs(organization_id, id);
create unique index raw_data_objects_org_identity on raw_data_objects(organization_id, id);

create table import_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  data_stream_id uuid not null,
  version integer not null check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  approved_by_user_id uuid not null references app_users(id),
  approved_at timestamptz not null default now(),
  unique (organization_id, data_stream_id, version),
  unique (organization_id, id),
  foreign key (organization_id, data_stream_id) references data_streams(organization_id, id) on delete restrict
);

create table ingestion_import_manifests (
  organization_id uuid not null references organizations(id) on delete restrict,
  ingestion_run_id uuid primary key,
  original_raw_object_id uuid not null,
  profile_id uuid,
  parser_version text not null check (length(parser_version) between 1 and 120),
  selected_sheet text,
  source_format text not null check (source_format in ('csv','tsv','txt','json','xlsx')),
  normalization jsonb not null default '{}'::jsonb check(jsonb_typeof(normalization)='object'),
  row_locator_convention text not null default 'header=1; first data record=2',
  supersedes_run_id uuid,
  reviewed_by_user_id uuid not null references app_users(id),
  reviewed_at timestamptz not null default now(),
  foreign key (organization_id, ingestion_run_id) references ingestion_runs(organization_id, id) on delete restrict,
  foreign key (organization_id, original_raw_object_id) references raw_data_objects(organization_id, id) on delete restrict,
  foreign key (organization_id, profile_id) references import_profiles(organization_id, id) on delete restrict,
  foreign key (organization_id, supersedes_run_id) references ingestion_runs(organization_id, id) on delete restrict,
  check (supersedes_run_id is distinct from ingestion_run_id)
);
create index ingestion_import_manifests_org_source on ingestion_import_manifests(organization_id, original_raw_object_id);

alter table import_profiles enable row level security;
alter table import_profiles force row level security;
create policy import_profiles_tenant on import_profiles
  using (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);
alter table ingestion_import_manifests enable row level security;
alter table ingestion_import_manifests force row level security;
create policy ingestion_import_manifests_tenant on ingestion_import_manifests
  using (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.current_organization_id',true),'')::uuid);

do $$ begin
  if exists (select 1 from pg_roles where rolname='biznoryx_app') then
    grant select, insert on import_profiles, ingestion_import_manifests to biznoryx_app;
  end if;
end $$;
commit;
